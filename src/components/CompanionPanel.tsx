import { useEffect, useState } from 'react';
import { ButtonItem, PanelSection, PanelSectionRow, ToggleField } from '@decky/ui';
import { callable } from '@decky/api';

interface Status {
  enabled: boolean; listening: boolean; error?: string; addresses: string[]; hostname: string;
  web_urls?: string[]; fingerprint: string; pairing_code: string; expires_in: number;
  devices: { id: string; name: string; last_seen?: number }[];
}
const status = callable<[], Status>('companion_status');
const enable = callable<[enabled: boolean], Status>('companion_enable');
const pair = callable<[], Status>('companion_pairing');
const revoke = callable<[deviceId: string], Status>('companion_revoke');

export function CompanionPanel({ visible }: { visible: boolean }) {
  const [data, setData] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remove, setRemove] = useState('');
  useEffect(() => {
    if (!visible) return;
    let active = true, pending = false;
    const update = async () => {
      if (pending) return;
      pending = true;
      try { const next = await status(); if (active) setData(next); }
      catch (e) { if (active) setError(String(e)); }
      finally { pending = false; }
    };
    void update();
    const timer = window.setInterval(() => void update(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [visible]);
  const run = async (action: () => Promise<Status>) => {
    setBusy(true); setError('');
    try { setData(await action()); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <PanelSection title="Phone & web companion">
    <PanelSectionRow><ToggleField label="Enable phone & web companion" checked={Boolean(data?.enabled)} disabled={busy}
      description="Control Value Forge from Android or a web browser on the same home network."
      onChange={checked => void run(() => enable(checked))} /></PanelSectionRow>
    {(error || data?.error) && <PanelSectionRow><div className="mds-error" role="alert">{error || data?.error}</div></PanelSectionRow>}
    {data?.listening && <>
      <PanelSectionRow><div className="mds-card">
        <div className="mds-name">Android app or local web browser</div>
        <div className="mds-muted">Steam Machine address</div>
        {(data.addresses ?? []).map(address => <div className="mds-code" key={address}>{address}</div>)}
        <div className="mds-code mds-muted">{data.hostname}</div>
        <div className="mds-muted">Open in a browser on your home network:</div>
        {(data.web_urls ?? []).map(url => <div className="mds-code" key={url}>{url}</div>)}
        <div className="mds-muted">Browsers need a one-time local certificate trust step. Compare the browser certificate’s SHA-256 fingerprint with this value:</div>
        <div className="mds-code">{data.fingerprint?.toUpperCase().match(/.{1,4}/g)?.join(' ')}</div>
        {data.pairing_code && <>
          <div className="mds-muted">Pairing code · expires in {data.expires_in}s</div>
          <div className="mds-value">{data.pairing_code}</div>
        </>}
      </div></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy} description="Open the local web address or Android app, then enter a new code. In Android, compare the first five fingerprint blocks. Each browser/app remembers its own pairing."
        onClick={() => void run(pair)}>{data.pairing_code ? 'Create a new pairing code' : 'Pair a phone or browser'}</ButtonItem></PanelSectionRow>
      {(data.devices ?? []).map(device => <PanelSectionRow key={device.id}>
        <ButtonItem layout="below" disabled={busy}
          description={device.last_seen ? `Last connected ${new Date(device.last_seen * 1000).toLocaleTimeString()}` : 'Paired · waiting for connection'}
          onClick={() => {
            if (remove !== device.id) { setRemove(device.id); return; }
            void run(() => revoke(device.id)); setRemove('');
          }}>{remove === device.id ? `Confirm remove ${device.name}` : `Remove ${device.name}`}</ButtonItem>
      </PanelSectionRow>)}
    </>}
  </PanelSection>;
}
