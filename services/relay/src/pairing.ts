import { customAlphabet } from "nanoid";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import type { DeviceRole } from "./types.js";

const JWT_SECRET = process.env.JWT_SECRET || "vanessa_default_jwt_secret_buildathon";
const TOKEN_TTL = process.env.TOKEN_TTL_SECONDS ?? "900";
const codeGenerator = customAlphabet("23456789", 6);

export function createPairingCode() {
  return codeGenerator();
}

export function createTotpSecret() {
  return authenticator.generateSecret();
}

export function verifyTotp(secret: string, token: string) {
  try {
    return authenticator.verify({ secret, token });
  } catch {
    return false;
  }
}

export function createDeviceToken(input: {
  deviceId: string;
  deviceName: string;
  role: DeviceRole;
  pairingCode: string;
}) {
  return jwt.sign(
    {
      sub: input.deviceId,
      deviceName: input.deviceName,
      role: input.role,
      pairingCode: input.pairingCode,
    },
    JWT_SECRET,
    { expiresIn: Number(TOKEN_TTL) }
  );
}

export function verifyDeviceToken(token: string) {
  return jwt.verify(token, JWT_SECRET) as {
    sub: string;
    deviceName: string;
    role: DeviceRole;
    pairingCode: string;
  };
}
