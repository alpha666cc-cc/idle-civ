import { useState } from "react";
import { parseFlexibleNumber } from "../game/numberFormat";
import type { ExpNumber } from "../game/expNumber";

type Props = {
  label: string;
  /** Display text for the committed value; shown whenever the field is idle. */
  value: string;
  ariaLabel: string;
  placeholder?: string;
  /**
   * Applies the parsed value. Return `false` to reject it — the field then
   * reverts to the committed display text.
   */
  onCommit: (value: ExpNumber) => boolean;
};

/**
 * Dev-tools numeric field. It keeps a local draft so typing is never fought by
 * the controlled value, and only parses/commits on Enter or blur (Escape
 * reverts). Accepts plain, scientific (`1.5e6`) and suffixed (`1.5K`, `2M`)
 * forms through `parseFlexibleNumber`.
 */
export default function DevNumberField({
  label,
  value,
  ariaLabel,
  placeholder,
  onCommit,
}: Props) {
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);

  // Resync the draft when the committed value changes for another reason
  // (number-format switch, another dev action). Adjusted during render rather
  // than in an effect so no extra commit is needed; typing never changes
  // `value`, so an in-progress draft is never clobbered.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  const revert = () => setDraft(value);

  const commit = () => {
    const text = draft.trim();
    if (text === value.trim()) return;
    const parsed = parseFlexibleNumber(text);
    if (parsed === null || !onCommit(parsed)) revert();
  };

  return (
    <label className="dev-tools-control">
      <span>{label}</span>
      <input
        type="text"
        inputMode="text"
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            revert();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
