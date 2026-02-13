
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.14.0/dist/transformers.min.js';

// Skip local checks so it works in browser without file access issues
env.allowLocalModels = false;
env.useBrowserCache = true;

/**
 * Worker for running Whisper locally in the browser.
 * Handles model loading, audio processing, and transcription.
 */

class WhisperWorker {
    constructor() {
        this.pipe = null;
        this.modelId = 'Xenova/whisper-tiny.en';
        this.isLoading = false;
    }

    async load() {
        if (this.pipe) {
            postMessage({ status: 'ready', message: 'Model already loaded.' });
            return;
        }

        this.isLoading = true;
        postMessage({ status: 'loading', message: 'Loading model (approx. 40MB)...' });

        try {
            // Load the pipeline
            this.pipe = await pipeline('automatic-speech-recognition', this.modelId, {
                quantized: true,
                progress_callback: (data) => {
                    // Send progress updates back to main thread
                    if (data.status === 'progress') {
                        postMessage({ 
                            status: 'downloading', 
                            file: data.file, 
                            progress: data.progress 
                        });
                    }
                }
            });
            
            this.isLoading = false;
            postMessage({ status: 'ready', message: 'Model loaded successfully.' });
        } catch (err) {
            console.error(err);
            postMessage({ status: 'error', message: 'Failed to load model: ' + err.message });
            this.isLoading = false;
        }
    }

    async transcribe(audio, isFinal) {
        if (!this.pipe) {
            await this.load();
        }

        try {
            // Run inference
            // For real-time, we process the chunk. 
            // Warning: Running inference is heavy.
            const result = await this.pipe(audio, {
                language: 'english',
                task: 'transcribe',
                chunk_length_s: 30,
                stride_length_s: 5,
            });

            // The result structure from transformers.js pipeline(audio) is usually { text: "..." }
            // or if return_timestamps is true, { text: "...", chunks: [...] }
            
            if (result && result.text) {
                const text = result.text.trim();
                if (text.length > 0) {
                     postMessage({ 
                        status: 'result', 
                        text: text, 
                        isFinal: isFinal 
                    });
                }
            }
        } catch (err) {
            console.error("Transcription error:", err);
        }
    }
}

const worker = new WhisperWorker();

onmessage = async (e) => {
    const { type, audio, isFinal } = e.data;

    if (type === 'load') {
        await worker.load();
    } else if (type === 'audio') {
        // audio should be a Float32Array
        await worker.transcribe(audio, isFinal);
    }
};
