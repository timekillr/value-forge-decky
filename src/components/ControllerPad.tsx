import { useState } from 'react';
import { ButtonItem, DialogButton, Focusable, type GamepadEvent } from '@decky/ui';

type Mode = 'number' | 'hex' | 'text';
interface Props {
  label: string; value: string; onChange: (value: string) => void;
  disabled?: boolean; mode?: Mode; initialOpen?: boolean; placeholder?: string;
}

// Same 7–8–9 / 4–5–6 / 1–2–3 / backspace–0–decimal arrangement as Memory Deck.
// All input is controlled by props; changing tabs/refreshing cannot leave a
// separate copy of the keypad value out of sync with the search value.
export function ControllerPad({ label, value, onChange, disabled = false,
  mode = 'number', initialOpen = false, placeholder = 'Empty' }: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [upper, setUpper] = useState(false);
  const clear = () => onChange(mode === 'number' ? '0' : mode === 'hex' ? '0x' : '');
  const backspace = () => {
    if (mode === 'number') {
      const next = value.slice(0, -1);
      onChange(!next || next === '-' ? '0' : next);
    } else if (mode === 'hex') {
      onChange(value.length <= 3 ? '0x' : value.slice(0, -1));
    } else onChange(value.slice(0, -1));
  };
  const enter = (key: string) => {
    if (mode === 'text') { if (value.length < 120) onChange(value + key); return; }
    if (mode === 'hex') {
      const digits = value.replace(/^0x/i, '');
      if (digits.length < 16) onChange('0x' + digits + key.toLowerCase());
      return;
    }
    if (value.length >= 128) return;
    if (key === '.') {
      if (value.includes('.') || /e/i.test(value)) return;
      onChange(!value || value === '-' ? value + '0.' : value + '.');
    } else if (value === '0') onChange(key);
    else if (value === '-0') onChange('-' + key);
    else onChange(value + key);
  };
  const consume = (event: GamepadEvent, action: () => void) => {
    if (disabled || !open) return;
    event.stopPropagation(); event.preventDefault(); action();
  };
  const keys = mode === 'number' ? ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'Backspace', '0', '.']
    : mode === 'hex' ? '789A456B123C0DEF'.split('')
    : (upper ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'abcdefghijklmnopqrstuvwxyz').split('').concat('0123456789'.split(''), ['.', '-', '_', '/']);
  return <Focusable className="mds-pad" data-pad={label}
    onSecondaryButton={event => consume(event, backspace)}
    onOptionsButton={event => consume(event, clear)}
    onCancelButton={event => consume(event, () => setOpen(false))}>
    <ButtonItem layout="below" disabled={disabled} onClick={() => setOpen(previous => !previous)}>
      {label}: <span className="mds-code">{value || placeholder}</span>
    </ButtonItem>
    <output aria-label={label} className="mds-pad-readout">{value || placeholder}</output>
    {open && <>
      <div className="mds-muted">D-pad: move · A: select · X: backspace · Y: clear · B: close pad</div>
      <Focusable className={`mds-keypad mds-keypad-${mode}`}>
        {keys.map(key => <DialogButton key={key} disabled={disabled}
          onClick={() => key === 'Backspace' ? backspace() : enter(key)}>{key}</DialogButton>)}
      </Focusable>
      <Focusable className="mds-actions">
        {mode === 'number' && <DialogButton disabled={disabled} onClick={() => onChange(value.startsWith('-') ? value.slice(1) : '-' + (value || '0'))}>±</DialogButton>}
        {mode === 'text' && <>
          <DialogButton disabled={disabled} onClick={() => setUpper(previous => !previous)}>{upper ? 'Lowercase' : 'Uppercase'}</DialogButton>
          <DialogButton disabled={disabled} onClick={() => enter(' ')}>Space</DialogButton>
        </>}
        {mode !== 'number' && <DialogButton disabled={disabled} onClick={backspace}>Backspace</DialogButton>}
        <DialogButton disabled={disabled} onClick={clear}>Clear</DialogButton>
        <DialogButton disabled={disabled} onClick={() => setOpen(false)}>Done</DialogButton>
      </Focusable>
    </>}
  </Focusable>;
}
