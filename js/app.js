/**
 * App entry point — handles file upload and initializes visualizer
 */
import { HarParser } from './har-parser.js';
import { Visualizer } from './visualizer.js';

const visualizer = new Visualizer();

// ── File upload handling ──

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
});

// New file button
document.getElementById('btn-new-file')?.addEventListener('click', () => {
    document.getElementById('main-app').classList.remove('active');
    document.getElementById('upload-screen').style.display = 'flex';
    fileInput.value = '';
});

function processFile(file) {
    if (!file.name.endsWith('.har')) {
        alert('Please upload a .har file');
        return;
    }

    // Show loading
    dropZone.innerHTML = '<div class="spinner"></div><span>Parsing HAR file...</span>';

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const har = JSON.parse(e.target.result);
            const { messages, stats, error } = HarParser.parse(har);

            if (error) {
                dropZone.innerHTML = `
          <div class="drop-zone-icon">⚠️</div>
          <div class="drop-zone-text" style="color:var(--red)">${error}</div>
          <div class="drop-zone-text">Click to try another file</div>
        `;
                return;
            }

            visualizer.init(messages, stats, file.name);
        } catch (err) {
            dropZone.innerHTML = `
        <div class="drop-zone-icon">❌</div>
        <div class="drop-zone-text" style="color:var(--red)">Failed to parse: ${err.message}</div>
        <div class="drop-zone-text">Click to try another file</div>
      `;
        }
    };
    reader.readAsText(file);
}
