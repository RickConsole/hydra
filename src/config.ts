export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000; // Check for due tasks every minute
export const STORE_DIR = './store';
export const GROUPS_DIR = './groups';
export const DATA_DIR = './data';
export const MAIN_GROUP_FOLDER = 'main';

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
export const CLEAR_COMMAND = '/clear';
