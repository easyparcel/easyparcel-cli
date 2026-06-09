// Keep in sync with package.json "version".
export const CLI_VERSION = "0.1.8";

// Keep in sync with package.json "name".
export const PACKAGE_NAME = "@easyparcel/cli";

export function userAgent(): string {
  return `easyparcel-cli/${CLI_VERSION} node/${process.versions.node}`;
}
