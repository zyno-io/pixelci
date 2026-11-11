export const SETUP_TOKEN_STORAGE_KEY = 'pixelci:setupToken';

export function clearSetupToken() {
    try {
        sessionStorage.removeItem(SETUP_TOKEN_STORAGE_KEY);
    } catch {
        // sessionStorage unavailable
    }
}
