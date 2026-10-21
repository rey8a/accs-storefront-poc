// delayed.js — loads non-essential third-party scripts after a 3-second timeout

import { sampleRUM } from './aem.js';

// Helix RUM enhancer
sampleRUM.enhance();
