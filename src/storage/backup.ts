/**
 * JSON export / import of ALL decks plus the anonymous sync token.
 * No third-party cloud integration — the user can put the file wherever they want.
 */

import { getOrCreateUserId, isValidUserToken } from './identity';
import {
  countConflicts,
  mergeDeckProgress,
  readAllDeckProgress,
  type ConflictStrategy,
} from './progress-idb';
import type { ProgressFile } from '../srs/types';

export const BACKUP_FORMAT = 'srs-fretboard-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exported_at: string;
  user_token: string;
  decks: Record<string, ProgressFile>;
}

export function isProgressFile(value: unknown): value is ProgressFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<ProgressFile>;
  return typeof file.cards === 'object' && file.cards !== null;
}

export function parseBackupFile(raw: unknown): BackupFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Backup file is not a JSON object.');
  }
  const value = raw as Record<string, unknown>;

  // Full backup (token + every deck).
  if (value.format === BACKUP_FORMAT || (typeof value.user_token === 'string' && value.decks)) {
    const decks = value.decks;
    if (!decks || typeof decks !== 'object') {
      throw new Error('Backup file is missing a "decks" object.');
    }
    const parsed: Record<string, ProgressFile> = {};
    for (const [deckId, file] of Object.entries(decks as Record<string, unknown>)) {
      if (!isProgressFile(file)) {
        throw new Error(`Backup deck "${deckId}" is not a valid progress file.`);
      }
      parsed[deckId] = file;
    }
    const token = typeof value.user_token === 'string' ? value.user_token.trim() : '';
    return {
      format: BACKUP_FORMAT,
      version: Number(value.version ?? BACKUP_VERSION),
      exported_at: String(value.exported_at ?? new Date().toISOString()),
      user_token: token,
      decks: parsed,
    };
  }

  // Legacy Python/web progress.json — treat as the default guitar-standard deck.
  if (isProgressFile(value)) {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exported_at: String(value.updated_at ?? new Date().toISOString()),
      user_token: '',
      decks: { 'guitar6-standard': value },
    };
  }

  throw new Error('File is not an SRS fretboard backup or progress.json.');
}

export async function buildBackup(dbName?: string): Promise<BackupFile> {
  const decks = await readAllDeckProgress(dbName);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    user_token: getOrCreateUserId(),
    decks,
  };
}

export function backupFilename(at: Date = new Date()): string {
  const yyyy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  const dd = String(at.getDate()).padStart(2, '0');
  return `srs-fretboard-backup-${yyyy}-${mm}-${dd}.json`;
}

export function downloadBackup(backup: BackupFile): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = backupFilename();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface ImportPlan {
  backup: BackupFile;
  tokenDiffers: boolean;
  importedTokenValid: boolean;
  conflicts: number;
}

export async function inspectImport(raw: unknown, dbName?: string): Promise<ImportPlan> {
  const backup = parseBackupFile(raw);
  const current = getOrCreateUserId();
  const importedTokenValid = isValidUserToken(backup.user_token);
  const tokenDiffers = importedTokenValid && backup.user_token.trim().toLowerCase() !== current;
  const conflicts = await countConflicts(backup.decks, dbName);
  return { backup, tokenDiffers, importedTokenValid, conflicts };
}

export async function applyImport(
  backup: BackupFile,
  strategy: ConflictStrategy,
  dbName?: string,
): Promise<{ written: number; conflicts: number; keptLocal: number }> {
  return mergeDeckProgress(backup.decks, strategy, dbName);
}
