import { handlePlaySave } from '../../server/play-saves.js';

export const onRequest = context => handlePlaySave(context.request, context.env);
