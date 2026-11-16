'use strict';

// The frame round a gif's area follows the recording: ready, count, rec.
window.snipr.onFrameState((state) => { document.body.dataset.state = state; });
