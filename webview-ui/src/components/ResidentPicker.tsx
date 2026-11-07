import { useState } from 'react';

import { MAX_RESIDENT_NAME_LENGTH, PROVIDER_IDS } from '../constants.js';
import { fallbackPaletteFor, providerLabel } from '../office/engine/residents.js';
import { getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { Button } from './ui/Button.js';
import { Dropdown } from './ui/Dropdown.js';

/** Mug shot size in the picker grid (CSS px). */
const PREVIEW_PX = 32;

interface ResidentPickerProps {
  isOpen: boolean;
  /** Add a resident of this agent type with an optional name. */
  onAdd: (providerId: string, name: string) => void;
}

/**
 * The `+ Resident` drawer: pick an agent type (each shown in its own skin,
 * or the palette sprite it falls back to) and an optional name. The resident
 * then lives in the office, roaming, and becomes the body of the next agent
 * of that type that starts.
 */
export function ResidentPicker({ isOpen, onAdd }: ResidentPickerProps) {
  const [providerId, setProviderId] = useState<string>(PROVIDER_IDS[0]);
  const [name, setName] = useState('');
  const paletteCount = getLoadedCharacterCount();

  const submit = () => {
    onAdd(providerId, name);
    setName('');
  };

  return (
    <Dropdown isOpen={isOpen} className="w-max">
      <div data-testid="resident-picker" className="flex flex-col gap-6 px-4 py-2">
        <span className="text-sm text-text-muted">Agent type</span>
        <div className="grid grid-cols-4 gap-4">
          {PROVIDER_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setProviderId(id)}
              title={providerLabel(id)}
              data-provider-id={id}
              className={`flex flex-col items-center gap-1 p-2 border-2 rounded-none cursor-pointer ${
                id === providerId
                  ? 'bg-active-bg border-accent'
                  : 'bg-btn-bg border-transparent hover:bg-btn-hover'
              }`}
            >
              <CharacterMugShot
                palette={fallbackPaletteFor(id, paletteCount)}
                hueShift={0}
                providerId={id}
                skinHue={0}
                size={PREVIEW_PX}
              />
              <span className="text-xs leading-none">{providerLabel(id)}</span>
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-2 text-sm text-text-muted">
          Name (optional)
          <input
            type="text"
            value={name}
            maxLength={MAX_RESIDENT_NAME_LENGTH}
            placeholder={providerLabel(providerId)}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        </label>
        <Button variant="accent" size="md" onClick={submit} data-testid="resident-add">
          Add {providerLabel(providerId)}
        </Button>
      </div>
    </Dropdown>
  );
}
