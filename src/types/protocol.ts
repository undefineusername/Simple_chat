export interface RelayPayload {
    msgId: string;
    from: string;
    to: string;
    payload: Uint8Array | string | any;
    timestamp: number;
    type?: 'echo' | 'direct';
}

export interface RegisterMasterEvent {
    uuid: string; // AccountUUID
    username?: string;
    salt?: string;
    kdfParams?: any;
}
