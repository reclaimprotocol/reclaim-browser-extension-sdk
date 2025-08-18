import React, { useMemo, useState } from 'react';
import { reclaimExtensionSDK } from '@reclaimprotocol/browser-extension-sdk';

const PROVIDERS = [
  { id: '7519ad78-208a-425d-9fac-97c13b0f0d4d', name: 'Kaggle' },
];

const APP_ID = import.meta.env.VITE_RECLAIM_APP_ID;
const APP_SECRET = import.meta.env.VITE_RECLAIM_APP_SECRET;
const EXTENSION_ID = import.meta.env.VITE_RECLAIM_EXTENSION_ID;

export default function ReclaimDemo() {
  const [providerId, setProviderId] = useState(PROVIDERS[0].id);
  const [installed, setInstalled] = useState(null);
  const [statusUrl, setStatusUrl] = useState('');
  const [proofs, setProofs] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [req, setReq] = useState(null);

  const canStart = useMemo(() => !!providerId && installed !== false, [providerId, installed]);

  async function checkInstalled() {
    console.log("CHECKING INSTALLED", EXTENSION_ID);
    const ok = await reclaimExtensionSDK.isExtensionInstalled({ extensionID: EXTENSION_ID });
    console.log("CHECKED INSTALLED", ok);
    setInstalled(ok);
  }

  async function start() {
    try {
      setLoading(true);
      setError('');
      setProofs(null);
      console.log("STARTING", APP_ID, APP_SECRET, providerId, EXTENSION_ID);
      const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, providerId, {
        extensionID: EXTENSION_ID,
        // callbackUrl: 'https://your.server/receive-proofs' // optional
      });

      setReq(request);
      setStatusUrl(request.getStatusUrl());

      request.on('completed', (p) => {
        console.log("COMPLETED", p);
        setProofs(p);
        setLoading(false);
      });

      request.on('error', (e) => {
        console.log("ERROR", e);
        setError(e?.message || String(e));
        setLoading(false);
      });

      const p = await request.startVerification();
      
      console.log("START VERIFICATION", p);
      setProofs(p);
    } catch (e) {
      console.log("ERROR", e);
      setError(e?.message || String(e));
      setLoading(false);
    }
  }

  async function cancel() {
    try { await req?.cancel(); } catch {}
  }

  return (
    <div style={{ maxWidth: 560, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h2>Reclaim Verification</h2>

      <div style={{ marginBottom: 8 }}>
        <button onClick={checkInstalled}>Check Extension</button>
        {installed !== null && (
          <span style={{ marginLeft: 8 }}>
            {installed ? 'Extension detected' : 'Extension not found or ID mismatch'}
          </span>
        )}
      </div>

      <div style={{ marginBottom: 8 }}>
        <label>
          Provider:
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)} style={{ marginLeft: 8 }}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginBottom: 8 }}>
        <button onClick={start} disabled={!canStart || loading}>
          {loading ? 'Starting…' : 'Start verification'}
        </button>
        <button onClick={cancel} disabled={!req} style={{ marginLeft: 8 }}>
          Cancel
        </button>
      </div>

      {!!statusUrl && (
        <div style={{ marginBottom: 8 }}>
          Status URL: <a href={statusUrl} target="_blank" rel="noreferrer">{statusUrl}</a>
        </div>
      )}

      {!!error && <div style={{ color: 'crimson' }}>Error: {error}</div>}
      {!!proofs && (
        <pre style={{ background: '#f5f5f5', padding: 8, overflow: 'auto' }}>
{JSON.stringify(proofs, null, 2)}
        </pre>
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: '#555' }}>
        SDK version: {reclaimExtensionSDK.getVersion()}
      </div>
    </div>
  );
}