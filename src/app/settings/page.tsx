"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Editable fields
  const [webhookUrl, setWebhookUrl] = useState("");
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [alchemyKey, setAlchemyKey] = useState("");

  const fetchConfig = () => {
    setLoading(true);
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setWebhookUrl(data.DISCORD_ALERT_WEBHOOK || "");
        setAlchemyKey(data.ALCHEMY_API_KEY || "");
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

    // Also set as env var for current runtime
    if (webhookUrl) process.env.DISCORD_ALERT_WEBHOOK = webhookUrl;

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
          content: null,
          embeds: [{
            title: "🧪 MintBot Test Alert",
            description: "This is a test notification from your ACO AutoMint service.",
            color: 0x44ff44,
            timestamp: new Date().toISOString(),
            footer: { text: "MintBot — If you see this, alerts are working!" },
          }],
        }),
      });
      if (res.ok) alert("✅ Test alert sent successfully!");
      else alert(`❌ Failed: ${res.status} ${res.statusText}`);
    } catch (err: any) {
      alert(`❌ Error: ${err.message}`);
    }
  };

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="max-w-2xl space-y-6">
        {/* Alerting */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <h3 className="text-lg font-semibold mb-4">📢 Alerting</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                Discord Webhook URL
                <span className="text-zinc-600 ml-2">for job failure & RPC alerts</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                  placeholder="https://discord.com/api/webhooks/..."
                />
                <button
                  onClick={testWebhook}
                  className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm"
                >
                  🧪 Test
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RPC */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <h3 className="text-lg font-semibold mb-4">🔌 RPC Configuration</h3>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Alchemy API Key
              <span className="text-zinc-600 ml-2">free tier: 30M CU/month</span>
            </label>
            <input
              type="text"
              value={alchemyKey}
              onChange={(e) => setAlchemyKey(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
              placeholder="demo"
            />
          </div>
        </div>

        {/* Vault */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <h3 className="text-lg font-semibold mb-4">🔐 Vault</h3>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Vault Passphrase
              <span className="text-zinc-600 ml-2">encrypts private keys at rest</span>
            </label>
            <input
              type="password"
              value={vaultPassphrase}
              onChange={(e) => setVaultPassphrase(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
              placeholder="Leave blank to keep current"
            />
            <p className="text-xs text-red-400 mt-2">
              ⚠️ Changing the passphrase will make existing encrypted keys unreadable. Only change if you understand the consequences.
            </p>
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-4">
          <button
            onClick={save}
            disabled={saving}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {saving ? "Saving..." : "💾 Save Settings"}
          </button>
          {saved && <span className="text-green-400 text-sm">✅ Saved!</span>}
        </div>
      </div>
    </div>
  );
}
