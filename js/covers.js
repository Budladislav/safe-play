const DATABASE_NAME = "safe-play-assets";
const DATABASE_VERSION = 1;
const COVER_STORE = "covers";
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("Хранилище обложек недоступно на этом устройстве."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COVER_STORE)) database.createObjectStore(COVER_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Не удалось открыть хранилище обложек."));
  });
}

async function runStore(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COVER_STORE, mode);
    const store = transaction.objectStore(COVER_STORE);
    let result;
    try {
      result = operation(store);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      resolve(result?.result ?? result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Не удалось изменить хранилище обложек."));
    };
    transaction.onabort = transaction.onerror;
  });
}

export async function getAllCovers() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COVER_STORE, "readonly");
    const request = transaction.objectStore(COVER_STORE).getAll();
    request.onsuccess = () => resolve(request.result.map(normalizeCoverRecord).filter(Boolean));
    request.onerror = () => reject(request.error || new Error("Не удалось прочитать обложки."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  });
}

export async function saveCover(record) {
  const normalized = normalizeCoverRecord(record);
  if (!normalized) throw new Error("Файл обложки повреждён.");
  await runStore("readwrite", (store) => store.put(normalized));
  return normalized;
}

export async function deleteCover(id) {
  if (!id) return;
  await runStore("readwrite", (store) => store.delete(String(id)));
}

export async function clearCovers() {
  await runStore("readwrite", (store) => store.clear());
}

export async function replaceCovers(records) {
  const normalized = Array.isArray(records) ? records.map(normalizeCoverRecord).filter(Boolean) : [];
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COVER_STORE, "readwrite");
    const store = transaction.objectStore(COVER_STORE);
    store.clear();
    normalized.forEach((record) => store.put(record));
    transaction.oncomplete = () => {
      database.close();
      resolve(normalized);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Не удалось восстановить обложки."));
    };
    transaction.onabort = transaction.onerror;
  });
}

export async function processCoverFile(file, options = {}) {
  if (!(file instanceof Blob) || !String(file.type || "").startsWith("image/")) throw new Error("Выберите файл изображения.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Исходное изображение должно быть меньше 20 МБ.");
  const maxWidth = Math.max(320, Number(options.maxWidth || 900));
  const maxHeight = Math.max(480, Number(options.maxHeight || 1200));
  const image = await loadImage(file);
  const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#171a14";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  URL.revokeObjectURL(image.src);
  let dataUrl = canvas.toDataURL("image/webp", Number(options.quality || 0.82));
  if (!dataUrl.startsWith("data:image/webp")) dataUrl = canvas.toDataURL("image/jpeg", Number(options.quality || 0.84));
  return {
    dataUrl,
    mimeType: dataUrl.slice(5, dataUrl.indexOf(";")),
    width,
    height
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(image.src);
      reject(new Error("Не удалось прочитать изображение."));
    };
    image.src = URL.createObjectURL(file);
  });
}

function normalizeCoverRecord(record) {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id || "").slice(0, 160);
  const dataUrl = String(record.dataUrl || "");
  if (!id || !/^data:image\/(?:webp|jpeg|png);base64,/i.test(dataUrl)) return null;
  return {
    id,
    dataUrl,
    mimeType: String(record.mimeType || dataUrl.slice(5, dataUrl.indexOf(";"))).slice(0, 40),
    width: Math.max(1, Number(record.width || 1)),
    height: Math.max(1, Number(record.height || 1)),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
  };
}
