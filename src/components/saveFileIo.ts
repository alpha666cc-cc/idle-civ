/**
 * Browser I/O for the save system: clipboard plus file pick/save, with the
 * download-anchor and hidden-input fallbacks for browsers that do not expose the
 * File System Access API. Everything here is presentation-side plumbing — the
 * save *document* itself lives in `src/game/saveSystem.ts`, which stays DOM-free.
 */

/** Minimal File System Access API surface; lib.dom does not declare it yet. */
type FilePickerAcceptType = {
  description?: string;
  accept: Record<string, string[]>;
};

type SaveFilePickerOptions = {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
};

type OpenFilePickerOptions = {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
};

type WritableFile = {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
};

type WritableFileHandle = {
  createWritable(): Promise<WritableFile>;
};

type ReadableFileHandle = {
  getFile(): Promise<File>;
};

type PickerWindow = Window & {
  showSaveFilePicker?: (
    options?: SaveFilePickerOptions,
  ) => Promise<WritableFileHandle>;
  showOpenFilePicker?: (
    options?: OpenFilePickerOptions,
  ) => Promise<ReadableFileHandle[]>;
};

const pickerWindow = (): PickerWindow => window as unknown as PickerWindow;

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/** Copy text to the clipboard; `false` when the API is missing or refused. */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** Read text from the clipboard, or `null` when unavailable or empty. */
export const readTextFromClipboard = async (): Promise<string | null> => {
  try {
    if (!navigator.clipboard?.readText) return null;
    const text = await navigator.clipboard.readText();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
};

/** Save-as fallback: hand the browser a download and let it place the file. */
export const downloadTextFile = (
  fileName: string,
  text: string,
  mimeType: string,
): void => {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next task, once the click has consumed the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export type SaveTextResult = "saved" | "downloaded" | "cancelled";

/**
 * Write a save to a file the player chooses. Uses the File System Access API
 * when present (a real Save dialog) and falls back to a download otherwise.
 */
export const saveTextToFile = async (
  fileName: string,
  text: string,
  mimeType: string,
  accept: FilePickerAcceptType[],
): Promise<SaveTextResult> => {
  const picker = pickerWindow().showSaveFilePicker;
  if (!picker) {
    downloadTextFile(fileName, text, mimeType);
    return "downloaded";
  }
  try {
    const handle = await picker.call(pickerWindow(), {
      suggestedName: fileName,
      types: accept,
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([text], { type: mimeType }));
    await writable.close();
    return "saved";
  } catch (error) {
    if (isAbort(error)) return "cancelled";
    downloadTextFile(fileName, text, mimeType);
    return "downloaded";
  }
};

export type OpenedTextFile = { name: string; text: string };

/** Hidden `<input type="file">` Open dialog, for browsers without the picker. */
export const openTextFileViaInput = (
  accept: FilePickerAcceptType[],
): Promise<OpenedTextFile | null> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept
      .flatMap((type) => Object.values(type.accept).flat())
      .join(",");
    input.style.display = "none";
    let settled = false;
    const finish = (result: OpenedTextFile | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(result);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then((text) => finish({ name: file.name, text }))
        .catch(() => finish(null));
    });
    // A cancelled input fires no event in most browsers; drop it on blur.
    window.addEventListener(
      "focus",
      () => window.setTimeout(() => finish(null), 500),
      { once: true },
    );
    document.body.append(input);
    input.click();
  });

/** Pick a file and read it as text; `null` when the player cancels. */
export const openTextFile = async (
  accept: FilePickerAcceptType[],
): Promise<OpenedTextFile | null> => {
  const picker = pickerWindow().showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(pickerWindow(), {
        types: accept,
        multiple: false,
      });
      const file = await handle.getFile();
      return { name: file.name, text: await file.text() };
    } catch (error) {
      if (isAbort(error)) return null;
      // Fall through to the input element when the picker itself fails.
    }
  }
  return openTextFileViaInput(accept);
};

/** Accept lists, so every dialog offers the right extensions. */
export const jsonAccept: FilePickerAcceptType[] = [
  {
    description: "Idle Civilization save (JSON)",
    accept: { "application/json": [".json"] },
  },
];

export const xmlAccept: FilePickerAcceptType[] = [
  {
    description: "Idle Civilization save (XML)",
    accept: { "application/xml": [".xml"] },
  },
];

export const anySaveAccept: FilePickerAcceptType[] = [
  {
    description: "Idle Civilization save",
    accept: {
      "application/json": [".json"],
      "application/xml": [".xml"],
      "text/plain": [".txt"],
    },
  },
];

export const acceptForSaveFormat = (
  format: "base64" | "json" | "xml",
): FilePickerAcceptType[] => {
  if (format === "xml") return xmlAccept;
  if (format === "json") return jsonAccept;
  return anySaveAccept;
};

export const mimeForSaveFormat = (format: "base64" | "json" | "xml"): string =>
  format === "xml"
    ? "application/xml"
    : format === "json"
      ? "application/json"
      : "text/plain";
