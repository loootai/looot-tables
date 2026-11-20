import { createContext } from 'react';

/** True while the sheet's run is halted: its waiting cells hold still and say so, since only the banner resumes them. */
export const RunPausedContext = createContext(false);
