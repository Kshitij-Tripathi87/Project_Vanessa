import type { DeviceRole } from "./types.js";
export declare function createPairingCode(): string;
export declare function createTotpSecret(): string;
export declare function verifyTotp(secret: string, token: string): boolean;
export declare function createDeviceToken(input: {
    deviceId: string;
    deviceName: string;
    role: DeviceRole;
    pairingCode: string;
}): string;
export declare function verifyDeviceToken(token: string): {
    sub: string;
    deviceName: string;
    role: DeviceRole;
    pairingCode: string;
};
//# sourceMappingURL=pairing.d.ts.map