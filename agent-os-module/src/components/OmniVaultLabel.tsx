"use client";

import { useEffect, useState } from "react";

// The Vault the dashboard actually uses, for the Memory panel's footer. It replaced a
// fixed "~/Documents/Obsidian Vault" that was wrong whenever AGENTIC_OS_VAULT or
// AGENTIC_OS_CONFIG pointed somewhere else. Display only: it reads, never writes.

interface Info { vaultRoot?: string; hostVaultRoot?: string | null }

export default function OmniVaultLabel() {
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/omniwatch/library", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setInfo((await r.json()) as Info);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <code>(unresolved)</code>;
  if (!info) return <code>…</code>;
  const host = info.hostVaultRoot || info.vaultRoot || "";
  const differs = Boolean(info.hostVaultRoot && info.vaultRoot && info.hostVaultRoot !== info.vaultRoot);
  return (
    <>
      <code data-omniwatch-vault>{host}</code>
      {differs && <span> · OmniWatch: <code>{info.vaultRoot}</code></span>}
    </>
  );
}
