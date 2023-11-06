import { createClient } from "@supabase/supabase-js";
import firebase from "firebase";
import { getSyncableElements, SyncableExcalidrawElement } from ".";
import { MIME_TYPES } from "../../src/constants";
import { decryptData } from "../../src/data/encryption";
import { restoreElements } from "../../src/data/restore";
import { getSceneVersion } from "../../src/element";
import { ExcalidrawElement, FileId } from "../../src/element/types";
import { AppState, BinaryFileData, DataURL } from "../../src/types";
import { ResolutionType } from "../../src/utility-types";
import Portal from "../collab/Portal";
import { reconcileElements } from "../collab/reconciliation";
import { encryptElements } from "./firebase";

const loadSupabase = async () => {
  const supabase = createClient(
    import.meta.env.VITE_APP_SUPABASE_URL || "http://localhost:8000",
    import.meta.env.VITE_APP_SUPABASE_ANON_KEY || "anon_key"
  );

  return supabase;
}


const doesDocExists = async (bucket: string, doc: string) => {
  const supabase = await loadSupabase();
  const { data, error } = await supabase.storage.from(bucket).list();
  if (error) {
    return false;
  }
  if (data) {
    return data.some((doc_comp) => doc_comp.name === doc);
  }
  return false;
}

interface SupabaseStoredScene {
  sceneVersion: number;
  elements: string;
}

const stringToArrayBuffer = (str: string) => {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0; i < str.length; i += 1) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
};

const stringToUint8Array = (str: string) => {
  return new Uint8Array(stringToArrayBuffer(str));
};
//
// const decryptElements = async (
//   data: SupabaseStoredScene,
//   roomKey: string,
// ): Promise<readonly ExcalidrawElement[]> => {
//   console.log("decrypting elements")
//   const cipherText = stringToArrayBuffer(data.ciphertext);
//   const iv = stringToUint8Array(data.iv);
//   console.log("cipherText", cipherText)
//   console.log("iv", iv)
//   const decrypted = await decryptData(iv, cipherText, roomKey);
//
//   const decodedData = new TextDecoder("utf-8").decode(new Uint8Array(decrypted));
//   console.log("decodedData",decodedData)
//   return JSON.parse(decodedData);
// }
//
class SupabaseSceneVersionCache {
  private static cache = new WeakMap<SocketIOClient.Socket, number>();
  static get = (socket: SocketIOClient.Socket) => {
    return SupabaseSceneVersionCache.cache.get(socket);
  };

  static set = (
    socket: SocketIOClient.Socket,
    elements: readonly SyncableExcalidrawElement[]
  ) => {
    SupabaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToSupabase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[]
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);
    return SupabaseSceneVersionCache.get(portal.socket) === sceneVersion; // check if there was a change in scene
  }
  return true
}

const createSupabaseBucket = async (prefix: string): Promise<boolean> => {
  const supabase = await loadSupabase();
  let needToCreateBucket = true;

  const { data, error } = await supabase.storage.listBuckets();

  if (error) {
    console.error(error);
    return false;
  }

  if (data) {
    data.forEach((bucket) => {
      if (bucket.name === prefix) {
        needToCreateBucket = false;
      }
    });
  }

  if (needToCreateBucket) {

    const { data, error } = await supabase.storage.createBucket(prefix, {
      public: true,
      allowedMimeTypes: [MIME_TYPES.binary]
    });
    if (error) {
      console.error(error);
      return false;
    }
    return true;
  }
  return true;
}

export const saveFilesToSupabase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: {
    id: FileId;
    buffer: Uint8Array;
  }[];
}) => {
  const supabase = await loadSupabase();
  const erroredFiles = new Map<FileId, true>(); // basically a set
  const savedFiles = new Map<FileId, true>(); // basically a set

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      console.log("creating bucket", prefix)
      console.log("creating file", id)
      const bucket = await createSupabaseBucket(prefix);
      if (!bucket) {
        console.error("Failed to create bucket");
      }
      const { data, error } = await supabase.storage
        .from(prefix)
        .upload(id, buffer);
      if (error) {
        erroredFiles.set(id, true);
      } else {
        savedFiles.set(id, true);
      }
    }
    )
  );

  return { savedFiles, erroredFiles };
}

const createSupabaseSceneDocument = async (
  supabase: ResolutionType<typeof loadSupabase>,
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
): Promise<SupabaseStoredScene> => {
  console.log(supabase, elements, roomKey)
  const sceneVersion = getSceneVersion(elements);
  return {
    sceneVersion,
    elements: JSON.stringify(elements),
  } as SupabaseStoredScene;
}

export const saveToSupabase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
): Promise<{
  elements: readonly SyncableExcalidrawElement[] | null;
  reconciledElements: readonly SyncableExcalidrawElement[] | null;
} | null> => {
  const { roomId, roomKey, socket } = portal;
  if (
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToSupabase(portal, elements)
  ) {
    return null;
  }

  console.log(roomId, roomKey, socket)

  const supabase = await loadSupabase();

  // create new scene
  console.log("creating new scene")

  const newScene = await createSupabaseSceneDocument(supabase, elements, roomKey);
  if (await doesDocExists("scenes", roomId)) { // if the doc exists, update it
    console.log("DOC EXISTS")
    const { data, error } = await supabase.storage.from("scenes").download(roomId);

    const prevDoc = JSON.parse(await data?.text() || "") as SupabaseStoredScene;
    console.log("prevDoc", prevDoc)

    // const decriptedElements = await decryptElements(prevDoc, roomKey);

    const prevElements = getSyncableElements(
      JSON.parse(prevDoc.elements)
    );

    const reconciledElements = getSyncableElements(
      reconcileElements(elements, prevElements, appState),
    )

    const sceneDocument = await createSupabaseSceneDocument(supabase, reconciledElements, roomKey);

    const { error: updateError } = await supabase.storage.from("scenes").update(roomId, JSON.stringify(sceneDocument));


    if (updateError) {
      console.log(updateError);
      return null;
    }

    SupabaseSceneVersionCache.set(socket, reconciledElements);

    return {
      elements: null,
      reconciledElements: reconciledElements,
    }
  }
  console.log("DOC DOESNT EXIST")
  // if the doc doesn't exist, create it
  const { data, error } = await supabase.storage.from("scenes").upload(roomId, JSON.stringify(newScene), {
    upsert: false,
  });
  if (error) {
    console.log(error);
    return null;
  }
  SupabaseSceneVersionCache.set(socket, elements);
  return { elements, reconciledElements: null };
}

export const loadFromSupabase = async (
  roomId: string,
  roomKey: string,
  socket: SocketIOClient.Socket | null,
): Promise<readonly ExcalidrawElement[] | null> => {
  const supabase = await loadSupabase();

  const { data, error } = await supabase.storage.from("scenes").download(roomId);
  console.log(data, error)
  if (error) {
    console.error(error);
    return null;
  }
  if (data === null) {
    return null;
  }
  const storedScene = JSON.parse(await data?.text() || "") as SupabaseStoredScene;
  const elements = getSyncableElements(
    JSON.parse(storedScene.elements)
  );
  console.log("elements", elements)

  if (socket) {
    SupabaseSceneVersionCache.set(socket, elements);
  }
  return restoreElements(elements, null);
}


export const loadFilesFromSupabase = async (
  prefix: string,
  decryptionKey: string,
  fileIds: readonly FileId[],
): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(fileIds)].map(async (id) => {
      const supabase = await loadSupabase();
      const { data, error } = await supabase.storage.from(prefix).download(id);
      if (error) {
        erroredFiles.set(id, true);
      } else {
        const dataURL = URL.createObjectURL(data);
        loadedFiles.push({
          mimeType: MIME_TYPES.binary,
          id: id,
          dataURL: dataURL as DataURL,
          created: Date.now(),
          lastRetrieved: Date.now(),
        });
      }
    })
  );
  return { loadedFiles, erroredFiles }

}
