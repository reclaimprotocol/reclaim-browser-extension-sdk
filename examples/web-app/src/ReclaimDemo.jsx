import React, { useMemo, useState } from 'react';
import { reclaimExtensionSDK } from '@reclaimprotocol/browser-extension-sdk';
import './ReclaimDemo.css';

const PROVIDERS = [
  {id: '50a2286d-8c89-4de0-817b-e577447c531d', name: 'Trex: Grok' },
  {id: '25a97f94-4c73-4c02-826d-d11504997fec', name: 'Trex: Perplexity' },
  {id: '3fa453f7-dc93-4150-a51f-c1b88bbcacb8', name: 'Trex: KuCoin' },
  {id: 'ea308ecf-f59d-4632-990a-ff0e8a6b73e9', name: 'Trex:Twitch' },
  {id: '32dc2faa-77fa-4af1-a8ed-5df70fdca8dd', name: 'Trex: Claude' },
  { id: '7a956c12-486a-4d18-a81f-833c62b8b055', name: 'Gamerpay' },
  { id: '1be4821a-55cb-42b1-a208-6158910c79a0', name: 'Steam Trade History' },
  { id: '7519ad78-208a-425d-9fac-97c13b0f0d4d', name: 'Kaggle' },
];

const APP_ID = import.meta.env.VITE_RECLAIM_APP_ID;
const APP_SECRET = import.meta.env.VITE_RECLAIM_APP_SECRET;
const EXTENSION_ID = import.meta.env.VITE_RECLAIM_EXTENSION_ID;

// Helper component to parse and display extracted parameters
const ExtractedParams = ({ context }) => {
  try {
    const contextData = JSON.parse(context);
    const extractedParams = contextData.extractedParameters || {};
    
    if (Object.keys(extractedParams).length === 0) {
      return <div className="no-data">No extracted parameters</div>;
    }

    return (
      <div className="params-grid">
        {Object.entries(extractedParams).map(([key, value]) => (
          <div key={key} className="param-item">
            <span className="param-key">{key}:</span>
            <span className="param-value">{String(value).substring(0, 100)}{String(value).length > 100 ? '...' : ''}</span>
          </div>
        ))}
      </div>
    );
  } catch (e) {
    return <div className="error-text">Error parsing context: {e.message}</div>;
  }
};

// Helper component to display public data
const PublicData = ({ publicData }) => {
  if (!publicData) {
    return <div className="no-data">No public data available</div>;
  }
  
  return (
    <div className="public-data">
      <pre>{JSON.stringify(publicData, null, 2)}</pre>
    </div>
  );
};

// Main proof card component
const ProofCard = ({ proof, index }) => {
  const [activeTab, setActiveTab] = useState('summary');
  
  const copyToClipboard = (data, type) => {
    navigator.clipboard.writeText(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    // Visual feedback
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = originalText, 1500);
  };

  return (
    <div className="proof-card">
      <div className="proof-card-header">
        <h4>Proof #{index + 1}</h4>
        <div className="proof-id">
          ID: {proof.identifier?.substring(0, 16)}...
          <button 
            className="copy-button-small"
            onClick={() => copyToClipboard(proof.identifier, 'ID')}
          >
            📋
          </button>
        </div>
      </div>

      <div className="tab-navigation">
        <button 
          className={`tab-button ${activeTab === 'summary' ? 'active' : ''}`}
          onClick={() => setActiveTab('summary')}
        >
          Summary
        </button>
        <button 
          className={`tab-button ${activeTab === 'params' ? 'active' : ''}`}
          onClick={() => setActiveTab('params')}
        >
          Extracted Params
        </button>
        <button 
          className={`tab-button ${activeTab === 'public' ? 'active' : ''}`}
          onClick={() => setActiveTab('public')}
        >
          Public Data
        </button>
        <button 
          className={`tab-button ${activeTab === 'raw' ? 'active' : ''}`}
          onClick={() => setActiveTab('raw')}
        >
          Full JSON
        </button>
      </div>

      <div className="tab-content">
        {activeTab === 'summary' && (
          <div className="summary-content">
            <div className="summary-grid">
              <div className="summary-item">
                <label>Provider:</label>
                <span>{proof.claimData?.provider || 'Unknown'}</span>
              </div>
              <div className="summary-item">
                <label>Owner:</label>
                <span>{proof.claimData?.owner?.substring(0, 20)}...</span>
              </div>
              <div className="summary-item">
                <label>Timestamp:</label>
                <span>{new Date(proof.claimData?.timestampS * 1000).toLocaleString()}</span>
              </div>
              <div className="summary-item">
                <label>Epoch:</label>
                <span>{proof.claimData?.epoch}</span>
              </div>
              <div className="summary-item">
                <label>Witnesses:</label>
                <span>{proof.witnesses?.length || 0}</span>
              </div>
              <div className="summary-item">
                <label>Signatures:</label>
                <span>{proof.signatures?.length || 0}</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'params' && (
          <div className="params-content">
            <div className="content-header">
              <h5>Extracted Parameters</h5>
              <button 
                className="copy-button-small"
                onClick={(e) => copyToClipboard(proof.claimData?.context, 'params')}
              >
                📋 Copy
              </button>
            </div>
            <ExtractedParams context={proof.claimData?.context} />
          </div>
        )}

        {activeTab === 'public' && (
          <div className="public-content">
            <div className="content-header">
              <h5>Public Data</h5>
              <button 
                className="copy-button-small"
                onClick={(e) => copyToClipboard(proof.publicData, 'public data')}
              >
                📋 Copy
              </button>
            </div>
            <PublicData publicData={proof.publicData} />
          </div>
        )}

        {activeTab === 'raw' && (
          <div className="raw-content">
            <div className="content-header">
              <h5>Complete Proof Object</h5>
              <button 
                className="copy-button-small"
                onClick={(e) => copyToClipboard(proof, 'proof')}
              >
                📋 Copy
              </button>
            </div>
            <div className="code-viewer">
              <pre>{JSON.stringify(proof, null, 2)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

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

      // request.setAppCallbackUrl("https://6cf90f1e87f7.ngrok-free.app/receive-proofs");
      // request.setParams({ userProfileLink: "https://steamcommunity.com/id/Sa2199/" });

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
            <div className="proof-container">
              <div className="proof-header">
                <h3>Verification Results</h3>
                <button 
                  className="copy-button"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(proofs, null, 2));
                    // Add a visual feedback
                    const btn = document.querySelector('.copy-button');
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => btn.textContent = originalText, 2000);
                  }}
                  title="Copy full proof data to clipboard"
                >
                  📋 Copy All
                </button>
              </div>

              {proofs.map((proof, index) => (
                <ProofCard key={proof.identifier || index} proof={proof} index={index} />
              ))}
            </div>
          </section>
        )}
        
      </div>
    </div>
  );
}