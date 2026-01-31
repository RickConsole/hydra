export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const STORE_DIR = './store';
export const GROUPS_DIR = './groups';
export const DATA_DIR = './data';

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
export const CLEAR_COMMAND = '/clear';
