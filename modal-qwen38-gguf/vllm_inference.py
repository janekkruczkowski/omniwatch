"""Qwen3.8 Q8_0 GGUF on one Modal RTX PRO 6000 (text-only API)."""

import json
import modal

MODEL_REPO = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"
MODEL_REVISION = "45d0fc0ad6cfcf9eeee6008ddaea925536409b18"
MODEL_FILE = "Qwen3.8-27B-Uncensored-Q8_0.gguf"  # fused MTP, but MTP is off initially
MMPROJ_FILE = "mmproj-Qwen3.8-27B-Uncensored-F16.gguf"
CONFIG_REPO = "JonathanColetti/Qwen3.8-27B-Uncensored"
CONFIG_REVISION = "5bb7aa90f0efef548e87005b1fb7658e522b6b7f"
SERVED_MODEL_NAME = "qwen38-27b-uncensored-q8"
PORT = 8000

# The out-of-tree plugin is compiled against the installed vLLM/PyTorch/CUDA.
GGUF_PLUGIN_COMMIT = "e2b8ad532b8b5ea175100202c30430c1d2b5e6a8"

image = (
    modal.Image.from_registry("nvidia/cuda:13.0.2-devel-ubuntu24.04", add_python="3.12")
    .entrypoint([])
    .apt_install("git", "build-essential")
    .env(
        {
            "UV_TORCH_BACKEND": "cu130",
            "HF_XET_HIGH_PERFORMANCE": "1",
            # CUDA extensions must use a Linux GCC host compiler, not clang++.
            "CC": "/usr/bin/gcc",
            "CXX": "/usr/bin/g++",
            "CUDAHOSTCXX": "/usr/bin/g++",
            "TORCH_CUDA_ARCH_LIST": "12.0",
        }
    )
    .uv_pip_install(
        "vllm==0.30.0",
        "gguf>=0.17.0",
        "huggingface_hub>=1.26.0",
        "setuptools>=77,<81",
        "wheel",
        "ninja",
    )
    .run_commands(
        "git clone https://github.com/vllm-project/vllm-gguf-plugin.git /opt/vllm-gguf-plugin",
        f"git -C /opt/vllm-gguf-plugin checkout {GGUF_PLUGIN_COMMIT}",
        "test -x /usr/bin/g++ && python -m pip install --no-build-isolation --no-deps /opt/vllm-gguf-plugin",
    )
)

app = modal.App("qwen38-27b-uncensored-q8")
hf_cache = modal.Volume.from_name("qwen38-gguf-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("qwen38-gguf-vllm-cache", create_if_missing=True)


@app.server(
    image=image,
    gpu="RTX-PRO-6000",
    port=PORT,
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_cache,
    },
    startup_timeout=30 * 60,  # first start downloads ~29 GB
    scaledown_window=5 * 60,
    unauthenticated=False,  # Modal Proxy Token in Authorization: Bearer ...
)
class Server:
    @modal.enter()
    def start(self):
        from pathlib import Path
        import shutil
        import subprocess

        from huggingface_hub import hf_hub_download, snapshot_download

        # Resolve the ONE requested weight file; never download every quant/draft.
        model_path = hf_hub_download(
            repo_id=MODEL_REPO,
            filename=MODEL_FILE,
            revision=MODEL_REVISION,
        )
        mmproj_path = hf_hub_download(
            repo_id=MODEL_REPO,
            filename=MMPROJ_FILE,
            revision=MODEL_REVISION,
        )
        # Download metadata/tokenizer only, not the unquantized 55+ GB weights.
        config_path = snapshot_download(
            repo_id=CONFIG_REPO,
            revision=CONFIG_REVISION,
            allow_patterns=[
                "config.json",
                "generation_config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "chat_template.jinja",
                "special_tokens_map.json",
                "preprocessor_config.json",
                "processor_config.json",
            ],
        )
        # The GGUF config parser reads config.json from the GGUF file's parent
        # directory. Symlink the large weight; copy only small HF metadata.
        serve_dir = Path("/root/.cache/huggingface/qwen38-q8-serving")
        serve_dir.mkdir(parents=True, exist_ok=True)
        serve_model = serve_dir / MODEL_FILE
        serve_model.unlink(missing_ok=True)
        serve_model.symlink_to(model_path)
        serve_mmproj = serve_dir / MMPROJ_FILE
        serve_mmproj.unlink(missing_ok=True)
        serve_mmproj.symlink_to(mmproj_path)
        for name in (
            "config.json",
            "generation_config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "chat_template.jinja",
            "special_tokens_map.json",
            "preprocessor_config.json",
            "processor_config.json",
        ):
            source = Path(config_path) / name
            if source.is_file():
                shutil.copy2(source, serve_dir / name)
        hf_cache.commit()

        command = [
            "vllm",
            "serve",
            str(serve_model),
            "--tokenizer",
            str(serve_dir),
            "--model-loader-extra-config",
            json.dumps({"mm_proj": str(serve_mmproj)}),
            "--served-model-name",
            SERVED_MODEL_NAME,
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
            "--language-model-only",
            "--reasoning-parser",
            "qwen3",
            "--max-model-len",
            "8192",
            "--gpu-memory-utilization",
            "0.85",
        ]
        print("Starting:", *command, flush=True)
        self.process = subprocess.Popen(command)

    @modal.exit()
    def stop(self):
        import subprocess

        process = getattr(self, "process", None)
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
