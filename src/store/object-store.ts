// Content-addressed, immutable, deduplicated, encrypted object store.
//
// putFile: split into chunks, convergently encrypt each, dedup via HEAD, and (for
// multi-chunk files) write a recipe object listing the chunk keys. Returns a StoredFile
// the manifest can point at. getFile reverses it.

import { ObjectBackend, PreconditionFailedError } from "./backend";
import type { Subkeys } from "../crypto/keys";
import { sha256, toHex, objectKeyFor, encryptObject, decryptObject } from "../crypto/object-cipher";

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB

export interface StoredFile {
  /** manifest pointer: the single object's key, or the recipe object's key. */
  objectKey: string;
  isRecipe: boolean;
  /** sha256 of the full plaintext (hex). */
  contentHash: string;
  size: number;
}

interface RecipeChunk {
  objectKey: string;
  size: number;
}
interface RecipeBody {
  chunks: RecipeChunk[];
  totalSize: number;
}

function objectPath(key: string): string {
  return `objects/${key.slice(0, 2)}/${key}`;
}

export class ObjectStore {
  constructor(
    private backend: ObjectBackend,
    private keys: Subkeys,
    private chunkSize: number = DEFAULT_CHUNK_SIZE,
  ) {}

  /** Encrypt+store one chunk (or recipe). Idempotent: skips upload if the object exists. */
  private async putBlob(plaintext: Uint8Array): Promise<{ objectKey: string; size: number }> {
    const objectKey = await objectKeyFor(this.keys.nameKey, plaintext);
    const path = objectPath(objectKey);
    if (await this.backend.head(path)) return { objectKey, size: plaintext.length };
    const blob = await encryptObject(this.keys.encKey, this.keys.nonceKey, plaintext);
    try {
      await this.backend.put(path, blob, { ifNoneMatch: true });
    } catch (e) {
      // Lost a race to an identical object — fine, it's content-addressed & immutable.
      if (!(e instanceof PreconditionFailedError)) throw e;
    }
    return { objectKey, size: plaintext.length };
  }

  async putFile(plaintext: Uint8Array): Promise<StoredFile> {
    const contentHash = toHex(await sha256(plaintext));
    const size = plaintext.length;

    if (size <= this.chunkSize) {
      const { objectKey } = await this.putBlob(plaintext);
      return { objectKey, isRecipe: false, contentHash, size };
    }

    const chunks: RecipeChunk[] = [];
    for (let off = 0; off < size; off += this.chunkSize) {
      const chunk = plaintext.subarray(off, Math.min(off + this.chunkSize, size));
      const { objectKey } = await this.putBlob(chunk);
      chunks.push({ objectKey, size: chunk.length });
    }
    // Recipe written last, after every chunk is confirmed stored.
    const recipe: RecipeBody = { chunks, totalSize: size };
    const recipePlain = new TextEncoder().encode(JSON.stringify(recipe));
    const { objectKey } = await this.putBlob(recipePlain);
    return { objectKey, isRecipe: true, contentHash, size };
  }

  private async getBlob(objectKey: string): Promise<Uint8Array> {
    const blob = await this.backend.get(objectPath(objectKey));
    if (!blob) throw new Error(`missing object: ${objectKey}`);
    return decryptObject(this.keys.encKey, blob);
  }

  /**
   * Chunk keys of a recipe object, without assembling the file. Used by deep coverage
   * audits to verify every chunk's presence and to make orphan detection accurate.
   * Throws if the recipe is missing or fails authentication (corruption is never silent).
   */
  async getRecipeChunkKeys(recipeKey: string): Promise<string[]> {
    const top = await this.getBlob(recipeKey);
    const recipe = JSON.parse(new TextDecoder().decode(top)) as RecipeBody;
    return recipe.chunks.map((c) => c.objectKey);
  }

  async getFile(ref: { objectKey: string; isRecipe: boolean }): Promise<Uint8Array> {
    const top = await this.getBlob(ref.objectKey);
    if (!ref.isRecipe) return top;

    const recipe = JSON.parse(new TextDecoder().decode(top)) as RecipeBody;
    const out = new Uint8Array(recipe.totalSize);
    let off = 0;
    for (const c of recipe.chunks) {
      const chunk = await this.getBlob(c.objectKey);
      out.set(chunk, off);
      off += chunk.length;
    }
    return out;
  }

  /**
   * Delete an object by its content key (retention purge). Only ever called with keys
   * the purge collector proved unreferenced by any live head.
   */
  async deleteObjectByKey(objectKey: string): Promise<void> {
    await this.backend.delete(objectPath(objectKey));
  }
}
