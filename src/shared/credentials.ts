/**
 * Credential Management
 * Securely stores and retrieves API keys from ~/.otus/credentials.json
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "fs";
import { GLOBAL_CONFIG, CREDENTIAL_KEYS, type CredentialKey } from "./constants.ts";

/**
 * Credentials stored in the config file
 */
export interface Credentials {
  openrouter_api_key?: string;
  voyage_api_key?: string;
  model?: string;
  max_iterations?: string;
}

/**
 * Get the global Otus config directory path (~/.otus)
 * Can be overridden with OTUS_TEST_HOME environment variable for testing
 */
export function getGlobalConfigDir(): string {
  const home = process.env.OTUS_TEST_HOME || homedir();
  return join(home, GLOBAL_CONFIG.DIR);
}

/**
 * Get the credentials file path (~/.otus/credentials.json)
 */
export function getCredentialsPath(): string {
  return join(getGlobalConfigDir(), GLOBAL_CONFIG.CREDENTIALS_FILE);
}

/**
 * Ensure the global config directory exists with secure permissions
 * Creates the directory with mode 0700 (rwx------)
 */
export function ensureSecureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } else {
    // Set permissions if directory already exists
    chmodSync(dirPath, 0o700);
  }
}

/**
 * Check if credentials file has secure permissions
 * Returns warning message if permissions are too open, null if secure
 */
export function checkPermissions(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const stats = statSync(filePath);
  const mode = stats.mode & 0o777; // Extract permission bits

  // File should be readable/writable only by owner (0600 or stricter)
  if (mode & 0o077) {
    return `WARNING: Permissions ${mode.toString(8)} for '${filePath}' are too open.\n` +
           `It is recommended that your credentials file is NOT accessible by others.\n` +
           `Run: chmod 600 ${filePath}`;
  }

  return null;
}

/**
 * Read credentials from the config file
 * Returns empty object if file doesn't exist
 */
export function readCredentials(): Credentials {
  const credPath = getCredentialsPath();
  
  if (!existsSync(credPath)) {
    return {};
  }

  // Check permissions and warn user
  const warning = checkPermissions(credPath);
  if (warning) {
    console.warn(warning);
  }

  try {
    const content = readFileSync(credPath, "utf-8");
    const data = JSON.parse(content);
    
    // Validate that only known keys are present
    const credentials: Credentials = {};
    for (const key of CREDENTIAL_KEYS) {
      if (key in data && typeof data[key] === "string") {
        credentials[key] = data[key];
      }
    }
    
    return credentials;
  } catch (error) {
    console.error(`Error reading credentials file: ${error}`);
    return {};
  }
}

/**
 * Write credentials to the config file with secure permissions
 * Creates directory and file with appropriate permissions (0700 and 0600)
 */
export function writeCredentials(credentials: Credentials): void {
  const configDir = getGlobalConfigDir();
  const credPath = getCredentialsPath();

  // Ensure directory exists with secure permissions
  ensureSecureDir(configDir);

  // Write credentials file
  const content = JSON.stringify(credentials, null, 2) + "\n";
  writeFileSync(credPath, content, { mode: 0o600 });

  // Ensure permissions are set correctly (in case umask interfered)
  chmodSync(credPath, 0o600);
}

/**
 * Set a single credential value
 */
export function setCredential(key: CredentialKey, value: string): void {
  const credentials = readCredentials();
  credentials[key] = value;
  writeCredentials(credentials);
}

/**
 * Get a single credential value
 * Returns undefined if not set
 */
export function getCredential(key: CredentialKey): string | undefined {
  const credentials = readCredentials();
  return credentials[key];
}

/**
 * Remove a credential from the config file
 */
export function unsetCredential(key: CredentialKey): void {
  const credentials = readCredentials();
  delete credentials[key];
  writeCredentials(credentials);
}

/**
 * Check if a credential is configured
 */
export function hasCredential(key: CredentialKey): boolean {
  const credentials = readCredentials();
  return key in credentials && credentials[key] !== undefined && credentials[key] !== "";
}

/**
 * Get all configured credential keys
 */
export function getConfiguredKeys(): CredentialKey[] {
  const credentials = readCredentials();
  return CREDENTIAL_KEYS.filter(key => hasCredential(key));
}
