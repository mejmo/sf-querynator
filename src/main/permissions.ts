import { session } from 'electron'

/** The only permission the app itself uses: the Copy button writes results to the clipboard. */
const ALLOWED = new Set(['clipboard-sanitized-write'])

/**
 * Deny every permission request (camera, microphone, notifications, geolocation, …) in the app window and in the
 * sign-in window's session, where third-party login pages run.
 */
export function lockDownPermissions() {
  for (const s of [session.defaultSession, session.fromPartition('persist:sso')]) {
    s.setPermissionRequestHandler((_webContents, permission, callback) => callback(ALLOWED.has(permission)))
    s.setPermissionCheckHandler((_webContents, permission) => ALLOWED.has(permission))
  }
}
