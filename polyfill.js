// Polyfill File API for Node 18 compatibility with undici
// This must be imported FIRST before any other modules

if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File {
    constructor(blobParts, filename, options = {}) {
      this.name = filename || '';
      this.lastModified = options.lastModified || Date.now();
      this.size = 0;
      this.type = options.type || '';
      this._blobParts = blobParts || [];
    }
    async text() {
      return '';
    }
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
    stream() {
      return new ReadableStream();
    }
    slice() {
      return this;
    }
  };
  
  // Also polyfill FileReader if needed
  if (typeof globalThis.FileReader === 'undefined') {
    globalThis.FileReader = class FileReader {
      constructor() {
        this.result = null;
        this.error = null;
        this.readyState = 0;
      }
      readAsText() {}
      readAsDataURL() {}
      readAsArrayBuffer() {}
    };
  }
}

export {};


