import React, { useMemo, useState } from 'react';
import { reclaimExtensionSDK } from '@reclaimprotocol/browser-extension-sdk';
import './ReclaimDemo.css';

const PROVIDERS = [
  { id: '9ab972fc-8aca-4c35-93f5-d1ede32e32b9', name: 'Trex - Instagram' },
  { id: '50a2286d-8c89-4de0-817b-e577447c531d', name: 'Trex - Grok' },
  { id: '7519ad78-208a-425d-9fac-97c13b0f0d4d', name: 'Kaggle' },
  { id: '25a97f94-4c73-4c02-826d-d11504997fec', name: 'Trex Perplexity' },
  { id: '218f590e-d755-44c9-82e3-04e9907d3f44', name: 'Trex - Chatgpt' },
  { id: '32dc2faa-77fa-4af1-a8ed-5df70fdca8dd', name: 'Claude' },
  { id: '921681c2-3d20-4060-b961-43ae2a0e8dd2', name: 'Gemini' },
  { id: '6b6d447f-caa7-461c-bd13-5c4738d7b4f9', name: 'Kaggle Injections' },
  { id: 'c9656893-ab80-4f17-9e88-0bcc33da123b', name: 'Kaggle Cascading' },
  { id: '31e222ba-be21-4bec-b767-af30f52836d9', name: 'Steam Trade' },
  { id: '31e222ba-be21-4bec-b767-af30f52837ea', name: 'Steam Inventory' },
  { id: '214861a3-191b-427b-9862-75e301f1e63b', name: 'Tiktok' },
  { id: 'fbf83028-fbed-4414-b593-fa5d3e3fa131', name: 'Trex - Binance' },
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
    const ok = await reclaimExtensionSDK.isExtensionInstalled({ extensionID: EXTENSION_ID });
    setInstalled(ok);
  }

  async function start() {
    try {
      setLoading(true);
      setError('');
      setProofs(null);

      const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, providerId, {
        extensionID: EXTENSION_ID,
        // callbackUrl: 'https://your.server/receive-proofs' // optional
      });

      // request.setAppCallbackUrl("https://ca4d0a506d63.ngrok-free.app/receive-proofs");


      setReq(request);
      setStatusUrl(request.getStatusUrl());

      request.on('completed', (p) => {
        console.log(p, "completed");
        setProofs(p);
        setLoading(false);
      });

      request.on('error', (e) => {
        console.log(e, "Error");
        setError(e?.message || String(e));
        setLoading(false);
      });

      const p = await request.startVerification();
      console.log(p, "p startVerification");
      setProofs(p);
    } catch (e) {
      setError(e?.message || String(e));
      setLoading(false);
    }
  }


  async function start2() {
    try {
      setLoading(true);
      setError('');
      setProofs(null);

      const BASE_URL = "http://localhost:8000";
      const res = await fetch(`${BASE_URL}/generate-config`);
      const { reclaimProofRequestConfig } = await res.json();
      console.log(reclaimProofRequestConfig, "reclaimProofRequestConfig");

      const request = reclaimProofRequestConfig.fromJsonString(reclaimProofRequestConfig, {
        extensionID: EXTENSION_ID,
      });

  
      

      // request.setParams({
      //   // srivatsan
      //   username: "76561198886166562",
      //   // mushaheed
      //   // username: "white_shadow_x7"
      // });

    //   request.setParams({
    //     "theirTradeLink": "https://steamcommunity.com/tradeoffer/new/?partner=482038931&token=7d8YweiW",
    //     "tradeOfferMessage": "Hello, my first one....",
    //     "myTradeAssets": "{\"assets\":[],\"currency\":[],\"ready\":false}",
    //     "theirTradeAssets": "{\"assets\":[{\"appid\":753,\"contextid\":\"6\",\"amount\":\"1\",\"assetid\":\"16773845215\"}],\"currency\":[],\"ready\":false}"
    // });

      setReq(request);
      setStatusUrl(request.getStatusUrl());

      request.on('completed', (p) => {
        console.log(p, "completed");
        setProofs(p);
        setLoading(false);
      });

      request.on('error', (e) => {
        console.log(e, "Error");
        setError(e?.message || String(e));
        setLoading(false);
      });

      const p = await request.startVerification();
      console.log(p, "p startVerification");
      setProofs(p);
    } catch (e) {
      setError(e?.message || String(e));
      setLoading(false);
    }
  }


  async function cancel() {
    // eslint-disable-next-line no-empty
    try { await req?.cancel(); } catch { }
  }

  return (
    <div className="reclaim-demo">
      <div className="demo-card">
        <header className="demo-header">
          <div className="badge">Reclaim Protocol</div>
          <h1>Extension SDK demo</h1>
          <p className="subtitle">
            Trigger a verification flow from the web and receive proofs via the installed extension.
          </p>
        </header>

        <section className="section">
          <div className="row">
            <button className="btn btn-secondary" onClick={checkInstalled}>
              {installed === null ? 'Check Extension' : (installed ? 'Extension detected' : 'Extension not found')}
            </button>

            <div className={`pill ${installed ? 'ok' : installed === false ? 'bad' : 'idle'}`}>
              {installed === null ? 'Unknown' : installed ? 'Ready' : 'Missing/ID mismatch'}
            </div>
          </div>
        </section>

        <section className="section grid">
          <div className="field">
            <label htmlFor="provider">Provider</label>
            <select
              id="provider"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="input"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>SDK version</label>
            <div className="info-box">{reclaimExtensionSDK.getVersion()}</div>
          </div>
        </section>

        <section className="section row">
          <button className="btn btn-primary" onClick={start} disabled={!canStart || loading}>
            {loading ? 'Starting…' : 'Start verification'}
          </button>
          <button className="btn btn-ghost" onClick={cancel} disabled={!req}>
            Cancel
          </button>
        </section>

        {!!statusUrl && (
          <section className="section">
            <div className="status-line">
              <span className="status-label">Status URL:</span>
              <a href={statusUrl} target="_blank" rel="noreferrer" className="link">
                {statusUrl}
              </a>
            </div>
          </section>
        )}

        {!!error && (
          <section className="section">
            <div className="alert error">Error: {error}</div>
          </section>
        )}

        {!!proofs && (
          <section className="section">
            <div className="code-block">
              <pre>{JSON.stringify(proofs, null, 2)}</pre>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}