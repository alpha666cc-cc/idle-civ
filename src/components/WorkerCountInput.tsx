import {
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import {
  formatWholeNumber,
  parseFlexibleNumber,
  type NumberFormat,
} from "../game/numberFormat";
import type { ExpNumber } from "../game/expNumber";

type Props = {
  /** Resource label, used for the aria-label. */
  label: string;
  /** Current assigned worker count. */
  count: ExpNumber | number;
  /** Display number format (the player's preference). */
  format: NumberFormat;
  /**
   * Applies an absolute target count. The engine clamps assignment to the
   * available population and unassignment to the workers already assigned.
   */
  onCommit: (target: number) => void;
};

/**
 * Editable worker count between the −/+ buttons at the bottom of a production
 * card. It keeps a local draft so typing is never fought by the live value,
 * and only parses/commits on Enter or blur (Escape reverts). Accepts plain,
 * scientific (`1.5e6`) and suffixed (`1.5K`, `2M`) forms through
 * `parseFlexibleNumber`; the result is floored to a whole number.
 */
export default function WorkerCountInput({
  label,
  count,
  format,
  onCommit,
}: Props) {
  const displayValue = formatWholeNumber(count, format);

  const [draft, setDraft] = useState(displayValue);
  const [syncedValue, setSyncedValue] = useState(displayValue);

  // Resync the draft when the committed value changes for another reason
  // (tick, auto-assign, the +/− buttons, a number-format switch). Adjusted
  // during render rather than in an effect so no extra commit is needed;
  // typing never changes `count`, so an in-progress draft is never clobbered.
  if (displayValue !== syncedValue) {
    setSyncedValue(displayValue);
    setDraft(displayValue);
  }

  const revert = () => setDraft(displayValue);

  const commit = () => {
    const text = draft.trim();
    if (text === displayValue.trim()) return;
    const parsed = parseFlexibleNumber(text);
    if (parsed === null) {
      revert();
      return;
    }
    const target = Math.max(0, Math.floor(parsed.toNumber()));
    if (Number.isNaN(target)) {
      revert();
      return;
    }
    onCommit(target);
    // Force a resync on the next render: the engine may clamp the target
    // (or reject it entirely), and when the target equals the current count
    // no state change fires, so `displayValue` alone would never refresh the
    // draft away from what was just typed.
    setSyncedValue("");
  };

  return (
    <input
      type="text"
      inputMode="text"
      className="worker-count-input"
      value={draft}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        setDraft(event.target.value)
      }
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          revert();
          event.currentTarget.blur();
        }
      }}
      onFocus={(event: FocusEvent<HTMLInputElement>) => {
        // Select all text on focus for easy replacement.
        event.currentTarget.select();
      }}
      aria-label={`Set ${label} workers`}
      title="Type a worker count. Enter to commit, Escape to cancel."
    />
  );
}