// src/firebase.ts
// Firebase Admin singleton — lazy-guard pattern prevents double-init on concurrent first requests
import { initializeApp, cert, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import { config } from './config';

let _app: App | undefined;
let _auth: Auth | undefined;

export function getFirebaseAdmin(): { app: App; auth: Auth } {
  if (!_app) {
    _app = initializeApp({
      credential: cert({
        projectId: config.firebaseProjectId,
        clientEmail: config.firebaseClientEmail,
        privateKey: config.firebasePrivateKey,
      }),
    });
    _auth = getAuth(_app);
  }
  return { app: _app, auth: _auth! };
}
