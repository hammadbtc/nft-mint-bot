"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  // Editable fields
  const [webhookUrl, setWebhookUrl] = useState("");
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [alchemyKey, setAlchemyKey] = useState("");
  const [allowedIps, setAllowedIps] = useState("");
  const [workerCount, setWorkerCount] = useState("5");

  const fetchConfig = () => {
    setLoading(true);
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setWebhookUrl(data.DISCORD_ALERT_WEBHOOK || "");
        setAlchemyKey(data.ALCHEMY_API_KEY || "");
        setAllowedIps(data.ALLOWED_IPS || "");
        setWorkerCount(data.WORKER_COUNT || "5");
        setLoading(false);
      });
  };

  useEffect(() => { fetchConfig(); }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);

    const updates = [
      { key: "DISCORD_ALERT_WEBHOOK", value: webhookUrl },
      { key: "ALCHEMY_API_KEY", value: alchemyKey },
      { key: "ALLOWED_IPS", value: allowedIps },
      { key: "WORKER_COUNT", value: workerCount },
    ];

    if (vaultPassphrase) {
      updates.push({ key: "VAULT_PASSPHRASE", value: vaultPassphrase });
    }

    for (const { key, value } of updates) {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    }

    setSaving(false);
    setSaved(true);
    setVaultPassphrase("");
    setTimeout(() => setSaved(false), 3000);
    fetchConfig();
  };

  const testWebhook = async () => {
    if (!webhookUrl) return alert("Set a webhook URL first");
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "🧪 MintBot Test Alert",
            description: "This is a test notification from your ACO AutoMint service.",
            color: 0x44ff44,
            timestamp: new Date().toISOString(),
            footer: { text: "MintBot — If you see this, alerts are working!" },
          }],
        }),
      });
      if (res.ok) alert("✅ Test alert sent!");
      else alert(`❌ Failed: ${res.status}`);
    } catch (err: any) {
      alert(`❌ Error: ${err.message}`);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mintbot-export-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
    setExporting(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMessage("");
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (res.ok) {
        setImportMessage(`✅ Imported: ${result.imported?.collections || 0} collections, ${result.imported?.safetyList || 0} safety entries, ${result.imported?.config || 0} config values`);
        fetchConfig();
      } else {
        setImportMessage(`❌ ${result.error}`);
      }
    } catch (err: any) {
      setImportMessage(`❌ ${err.message}`);
    }
    setImporting(false);
  };

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="max-w-2xl space-y-6">
        {/* Alerting */}
        <Section title="📢 Alerting">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Discord Webhook URL
            </label>
            <div className="flex gap-2">
              <input type="text" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                placeholder="https://discord.com/api/webhooks/..." />
              <button onClick={testWebhook}
                className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm">🧪 Test</button>
            </div>
          </div>
        </Section>

        {/* RPC */}
        <Section title="🔌 RPC Configuration">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Alchemy API Key</label>
            <input type="text" value={alchemyKey} onChange={(e) => setAlchemyKey(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono" placeholder="demo" />
          </div>
          <div className="mt-3">
            <label className="block text-sm text-zinc-400 mb-1">
              Worker Concurrency <span className="text-zinc-600">(1-20 parallel jobs)</span>
            </label>
            <input type="number" min={1} max={20} value={workerCount} onChange={(e) => setWorkerCount(e.target.value)}
              className="w-32 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm" />
          </div>
        </Section>

        {/* Security */}
        <Section title="🔒 Security">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              IP Whitelist <span className="text-zinc-600">(comma-separated, empty = allow all)</span>
            </label>
            <input type="text" value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
              placeholder="1.2.3.4, 5.6.7.8" />
            <p className="text-xs text-zinc-600 mt-1">Set ALLOWED_IPS env var or configure here. Restart required.</p>
          </div>
        </Section>

        {/* Export / Import */}
        <Section title="💾 Backup & Restore">
          <p className="text-sm text-zinc-400 mb-3">
            Export collections, safety list, and config as JSON. Encrypted keys are NOT exported — re-import wallets separately.
          </p>
          <div className="flex flex-wrap gap-3">
            <button onClick={handleExport} disabled={exporting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm">
              {exporting ? "Exporting..." : "📥 Export Config"}
            </button>
            <label className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg text-sm cursor-pointer">
              {importing ? "Importing..." : "📤 Import Config"}
              <input type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
          </div>
          {importMessage && (
            <div className={`mt-2 text-sm ${importMessage.startsWith("✅") ? "text-green-400" : "text-red-400"}`}>
              {importMessage}
            </div>
          )}
        </Section>

        {/* Vault */}
        <Section title="🔐 Vault">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Vault Passphrase</label>
            <input type="password" value={vaultPassphrase} onChange={(e) => setVaultPassphrase(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
              placeholder="Leave blank to keep current" />
            <p className="text-xs text-red-400 mt-2">
              ⚠️ Changing the passphrase makes existing keys unreadable.
            </p>
          </div>
        </Section>

        {/* Save */}
        <div className="flex items-center gap-4">
          <button onClick={save} disabled={saving}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-medium">
            {saving ? "Saving..." : "💾 Save Settings"}
          </button>
          {saved && <span className="text-green-400 text-sm">✅ Saved!</span>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}
