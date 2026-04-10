/**
 * Fixture that throws at module-load time. Used to exercise the CLI's
 * generic import-error handling path.
 */
throw new Error("kaboom from cli-throwing-app");

export const app = null;
