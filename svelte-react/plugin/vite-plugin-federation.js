import { resolve, dirname, posix, basename, join, sep, extname, relative, parse } from 'path';
import { readFileSync, statSync, readdirSync } from 'fs';
import 'crypto';

const PREFIX = `\0virtual:`;
function virtual(modules) {
    const resolvedIds = new Map();
    Object.keys(modules).forEach((id) => {
        resolvedIds.set(resolve(id), modules[id]);
    });
    return {
        name: 'virtual',
        resolveId(id, importer) {
            if (id in modules)
                return PREFIX + id;
            if (importer) {
                const importerNoPrefix = importer.startsWith(PREFIX)
                    ? importer.slice(PREFIX.length)
                    : importer;
                const resolved = resolve(dirname(importerNoPrefix), id);
                if (resolvedIds.has(resolved))
                    return PREFIX + resolved;
            }
            return null;
        },
        load(id) {
            if (id.startsWith(PREFIX)) {
                const idNoPrefix = id.slice(PREFIX.length);
                return idNoPrefix in modules ? modules[idNoPrefix] : resolvedIds.get(idNoPrefix);
            }
            return null;
        }
    };
}

function walk(ast, { enter, leave }) {
    return visit(ast, null, enter, leave);
}

let should_skip = false;
let should_remove = false;
let replacement = null;
const context = {
    skip: () => should_skip = true,
    remove: () => should_remove = true,
    replace: (node) => replacement = node
};

function replace(parent, prop, index, node) {
    if (parent) {
        if (index !== null) {
            parent[prop][index] = node;
        } else {
            parent[prop] = node;
        }
    }
}

function remove(parent, prop, index) {
    if (parent) {
        if (index !== null) {
            parent[prop].splice(index, 1);
        } else {
            delete parent[prop];
        }
    }
}

function visit(
    node,
    parent,
    enter,
    leave,
    prop,
    index
) {
    if (node) {
        if (enter) {
            const _should_skip = should_skip;
            const _should_remove = should_remove;
            const _replacement = replacement;
            should_skip = false;
            should_remove = false;
            replacement = null;

            enter.call(context, node, parent, prop, index);

            if (replacement) {
                node = replacement;
                replace(parent, prop, index, node);
            }

            if (should_remove) {
                remove(parent, prop, index);
            }

            const skipped = should_skip;
            const removed = should_remove;

            should_skip = _should_skip;
            should_remove = _should_remove;
            replacement = _replacement;

            if (skipped) return node;
            if (removed) return null;
        }

        for (const key in node) {
            const value = (node)[key];

            if (typeof value !== 'object') {
                continue;
            }

            else if (Array.isArray(value)) {
                for (let j = 0, k = 0; j < value.length; j += 1, k += 1) {
                    if (value[j] !== null && typeof value[j].type === 'string') {
                        if (!visit(value[j], node, enter, leave, key, k)) {
                            // removed
                            j--;
                        }
                    }
                }
            }

            else if (value !== null && typeof value.type === 'string') {
                visit(value, node, enter, leave, key, null);
            }
        }

        if (leave) {
            const _replacement = replacement;
            const _should_remove = should_remove;
            replacement = null;
            should_remove = false;

            leave.call(context, node, parent, prop, index);

            if (replacement) {
                node = replacement;
                replace(parent, prop, index, node);
            }

            if (should_remove) {
                remove(parent, prop, index);
            }

            const removed = should_remove;

            replacement = _replacement;
            should_remove = _should_remove;

            if (removed) return null;
        }
    }

    return node;
}

var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
function encode(decoded) {
    var sourceFileIndex = 0; // second field
    var sourceCodeLine = 0; // third field
    var sourceCodeColumn = 0; // fourth field
    var nameIndex = 0; // fifth field
    var mappings = '';
    for (var i = 0; i < decoded.length; i++) {
        var line = decoded[i];
        if (i > 0)
            mappings += ';';
        if (line.length === 0)
            continue;
        var generatedCodeColumn = 0; // first field
        var lineMappings = [];
        for (var _i = 0, line_1 = line; _i < line_1.length; _i++) {
            var segment = line_1[_i];
            var segmentMappings = encodeInteger(segment[0] - generatedCodeColumn);
            generatedCodeColumn = segment[0];
            if (segment.length > 1) {
                segmentMappings +=
                    encodeInteger(segment[1] - sourceFileIndex) +
                    encodeInteger(segment[2] - sourceCodeLine) +
                    encodeInteger(segment[3] - sourceCodeColumn);
                sourceFileIndex = segment[1];
                sourceCodeLine = segment[2];
                sourceCodeColumn = segment[3];
            }
            if (segment.length === 5) {
                segmentMappings += encodeInteger(segment[4] - nameIndex);
                nameIndex = segment[4];
            }
            lineMappings.push(segmentMappings);
        }
        mappings += lineMappings.join(',');
    }
    return mappings;
}
function encodeInteger(num) {
    var result = '';
    num = num < 0 ? (-num << 1) | 1 : num << 1;
    do {
        var clamped = num & 31;
        num >>>= 5;
        if (num > 0) {
            clamped |= 32;
        }
        result += chars[clamped];
    } while (num > 0);
    return result;
}

var BitSet = function BitSet(arg) {
    this.bits = arg instanceof BitSet ? arg.bits.slice() : [];
};

BitSet.prototype.add = function add(n) {
    this.bits[n >> 5] |= 1 << (n & 31);
};

BitSet.prototype.has = function has(n) {
    return !!(this.bits[n >> 5] & (1 << (n & 31)));
};

var Chunk = function Chunk(start, end, content) {
    this.start = start;
    this.end = end;
    this.original = content;

    this.intro = '';
    this.outro = '';

    this.content = content;
    this.storeName = false;
    this.edited = false;

    // we make these non-enumerable, for sanity while debugging
    Object.defineProperties(this, {
        previous: { writable: true, value: null },
        next: { writable: true, value: null },
    });
};

Chunk.prototype.appendLeft = function appendLeft(content) {
    this.outro += content;
};

Chunk.prototype.appendRight = function appendRight(content) {
    this.intro = this.intro + content;
};

Chunk.prototype.clone = function clone() {
    var chunk = new Chunk(this.start, this.end, this.original);

    chunk.intro = this.intro;
    chunk.outro = this.outro;
    chunk.content = this.content;
    chunk.storeName = this.storeName;
    chunk.edited = this.edited;

    return chunk;
};

Chunk.prototype.contains = function contains(index) {
    return this.start < index && index < this.end;
};

Chunk.prototype.eachNext = function eachNext(fn) {
    var chunk = this;
    while (chunk) {
        fn(chunk);
        chunk = chunk.next;
    }
};

Chunk.prototype.eachPrevious = function eachPrevious(fn) {
    var chunk = this;
    while (chunk) {
        fn(chunk);
        chunk = chunk.previous;
    }
};

Chunk.prototype.edit = function edit(content, storeName, contentOnly) {
    this.content = content;
    if (!contentOnly) {
        this.intro = '';
        this.outro = '';
    }
    this.storeName = storeName;

    this.edited = true;

    return this;
};

Chunk.prototype.prependLeft = function prependLeft(content) {
    this.outro = content + this.outro;
};

Chunk.prototype.prependRight = function prependRight(content) {
    this.intro = content + this.intro;
};

Chunk.prototype.split = function split(index) {
    var sliceIndex = index - this.start;

    var originalBefore = this.original.slice(0, sliceIndex);
    var originalAfter = this.original.slice(sliceIndex);

    this.original = originalBefore;

    var newChunk = new Chunk(index, this.end, originalAfter);
    newChunk.outro = this.outro;
    this.outro = '';

    this.end = index;

    if (this.edited) {
        // TODO is this block necessary?...
        newChunk.edit('', false);
        this.content = '';
    } else {
        this.content = originalBefore;
    }

    newChunk.next = this.next;
    if (newChunk.next) { newChunk.next.previous = newChunk; }
    newChunk.previous = this;
    this.next = newChunk;

    return newChunk;
};

Chunk.prototype.toString = function toString() {
    return this.intro + this.content + this.outro;
};

Chunk.prototype.trimEnd = function trimEnd(rx) {
    this.outro = this.outro.replace(rx, '');
    if (this.outro.length) { return true; }

    var trimmed = this.content.replace(rx, '');

    if (trimmed.length) {
        if (trimmed !== this.content) {
            this.split(this.start + trimmed.length).edit('', undefined, true);
        }
        return true;
    } else {
        this.edit('', undefined, true);

        this.intro = this.intro.replace(rx, '');
        if (this.intro.length) { return true; }
    }
};

Chunk.prototype.trimStart = function trimStart(rx) {
    this.intro = this.intro.replace(rx, '');
    if (this.intro.length) { return true; }

    var trimmed = this.content.replace(rx, '');

    if (trimmed.length) {
        if (trimmed !== this.content) {
            this.split(this.end - trimmed.length);
            this.edit('', undefined, true);
        }
        return true;
    } else {
        this.edit('', undefined, true);

        this.outro = this.outro.replace(rx, '');
        if (this.outro.length) { return true; }
    }
};

var btoa = function () {
    throw new Error('Unsupported environment: `window.btoa` or `Buffer` should be supported.');
};
if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    btoa = function (str) { return window.btoa(unescape(encodeURIComponent(str))); };
} else if (typeof Buffer === 'function') {
    btoa = function (str) { return Buffer.from(str, 'utf-8').toString('base64'); };
}

var SourceMap = function SourceMap(properties) {
    this.version = 3;
    this.file = properties.file;
    this.sources = properties.sources;
    this.sourcesContent = properties.sourcesContent;
    this.names = properties.names;
    this.mappings = encode(properties.mappings);
};

SourceMap.prototype.toString = function toString() {
    return JSON.stringify(this);
};

SourceMap.prototype.toUrl = function toUrl() {
    return 'data:application/json;charset=utf-8;base64,' + btoa(this.toString());
};

function guessIndent(code) {
    var lines = code.split('\n');

    var tabbed = lines.filter(function (line) { return /^\t+/.test(line); });
    var spaced = lines.filter(function (line) { return /^ {2,}/.test(line); });

    if (tabbed.length === 0 && spaced.length === 0) {
        return null;
    }

    // More lines tabbed than spaced? Assume tabs, and
    // default to tabs in the case of a tie (or nothing
    // to go on)
    if (tabbed.length >= spaced.length) {
        return '\t';
    }

    // Otherwise, we need to guess the multiple
    var min = spaced.reduce(function (previous, current) {
        var numSpaces = /^ +/.exec(current)[0].length;
        return Math.min(numSpaces, previous);
    }, Infinity);

    return new Array(min + 1).join(' ');
}

function getRelativePath(from, to) {
    var fromParts = from.split(/[/\\]/);
    var toParts = to.split(/[/\\]/);

    fromParts.pop(); // get dirname

    while (fromParts[0] === toParts[0]) {
        fromParts.shift();
        toParts.shift();
    }

    if (fromParts.length) {
        var i = fromParts.length;
        while (i--) { fromParts[i] = '..'; }
    }

    return fromParts.concat(toParts).join('/');
}

var toString = Object.prototype.toString;

function isObject(thing) {
    return toString.call(thing) === '[object Object]';
}

function getLocator(source) {
    var originalLines = source.split('\n');
    var lineOffsets = [];

    for (var i = 0, pos = 0; i < originalLines.length; i++) {
        lineOffsets.push(pos);
        pos += originalLines[i].length + 1;
    }

    return function locate(index) {
        var i = 0;
        var j = lineOffsets.length;
        while (i < j) {
            var m = (i + j) >> 1;
            if (index < lineOffsets[m]) {
                j = m;
            } else {
                i = m + 1;
            }
        }
        var line = i - 1;
        var column = index - lineOffsets[line];
        return { line: line, column: column };
    };
}

var Mappings = function Mappings(hires) {
    this.hires = hires;
    this.generatedCodeLine = 0;
    this.generatedCodeColumn = 0;
    this.raw = [];
    this.rawSegments = this.raw[this.generatedCodeLine] = [];
    this.pending = null;
};

Mappings.prototype.addEdit = function addEdit(sourceIndex, content, loc, nameIndex) {
    if (content.length) {
        var segment = [this.generatedCodeColumn, sourceIndex, loc.line, loc.column];
        if (nameIndex >= 0) {
            segment.push(nameIndex);
        }
        this.rawSegments.push(segment);
    } else if (this.pending) {
        this.rawSegments.push(this.pending);
    }

    this.advance(content);
    this.pending = null;
};

Mappings.prototype.addUneditedChunk = function addUneditedChunk(sourceIndex, chunk, original, loc, sourcemapLocations) {
    var originalCharIndex = chunk.start;
    var first = true;

    while (originalCharIndex < chunk.end) {
        if (this.hires || first || sourcemapLocations.has(originalCharIndex)) {
            this.rawSegments.push([this.generatedCodeColumn, sourceIndex, loc.line, loc.column]);
        }

        if (original[originalCharIndex] === '\n') {
            loc.line += 1;
            loc.column = 0;
            this.generatedCodeLine += 1;
            this.raw[this.generatedCodeLine] = this.rawSegments = [];
            this.generatedCodeColumn = 0;
            first = true;
        } else {
            loc.column += 1;
            this.generatedCodeColumn += 1;
            first = false;
        }

        originalCharIndex += 1;
    }

    this.pending = null;
};

Mappings.prototype.advance = function advance(str) {
    if (!str) { return; }

    var lines = str.split('\n');

    if (lines.length > 1) {
        for (var i = 0; i < lines.length - 1; i++) {
            this.generatedCodeLine++;
            this.raw[this.generatedCodeLine] = this.rawSegments = [];
        }
        this.generatedCodeColumn = 0;
    }

    this.generatedCodeColumn += lines[lines.length - 1].length;
};

var n = '\n';

var warned = {
    insertLeft: false,
    insertRight: false,
    storeName: false,
};

var MagicString = function MagicString(string, options) {
    if (options === void 0) options = {};

    var chunk = new Chunk(0, string.length, string);

    Object.defineProperties(this, {
        original: { writable: true, value: string },
        outro: { writable: true, value: '' },
        intro: { writable: true, value: '' },
        firstChunk: { writable: true, value: chunk },
        lastChunk: { writable: true, value: chunk },
        lastSearchedChunk: { writable: true, value: chunk },
        byStart: { writable: true, value: {} },
        byEnd: { writable: true, value: {} },
        filename: { writable: true, value: options.filename },
        indentExclusionRanges: { writable: true, value: options.indentExclusionRanges },
        sourcemapLocations: { writable: true, value: new BitSet() },
        storedNames: { writable: true, value: {} },
        indentStr: { writable: true, value: guessIndent(string) },
    });

    this.byStart[0] = chunk;
    this.byEnd[string.length] = chunk;
};

MagicString.prototype.addSourcemapLocation = function addSourcemapLocation(char) {
    this.sourcemapLocations.add(char);
};

MagicString.prototype.append = function append(content) {
    if (typeof content !== 'string') { throw new TypeError('outro content must be a string'); }

    this.outro += content;
    return this;
};

MagicString.prototype.appendLeft = function appendLeft(index, content) {
    if (typeof content !== 'string') { throw new TypeError('inserted content must be a string'); }

    this._split(index);

    var chunk = this.byEnd[index];

    if (chunk) {
        chunk.appendLeft(content);
    } else {
        this.intro += content;
    }
    return this;
};

MagicString.prototype.appendRight = function appendRight(index, content) {
    if (typeof content !== 'string') { throw new TypeError('inserted content must be a string'); }

    this._split(index);

    var chunk = this.byStart[index];

    if (chunk) {
        chunk.appendRight(content);
    } else {
        this.outro += content;
    }
    return this;
};

MagicString.prototype.clone = function clone() {
    var cloned = new MagicString(this.original, { filename: this.filename });

    var originalChunk = this.firstChunk;
    var clonedChunk = (cloned.firstChunk = cloned.lastSearchedChunk = originalChunk.clone());

    while (originalChunk) {
        cloned.byStart[clonedChunk.start] = clonedChunk;
        cloned.byEnd[clonedChunk.end] = clonedChunk;

        var nextOriginalChunk = originalChunk.next;
        var nextClonedChunk = nextOriginalChunk && nextOriginalChunk.clone();

        if (nextClonedChunk) {
            clonedChunk.next = nextClonedChunk;
            nextClonedChunk.previous = clonedChunk;

            clonedChunk = nextClonedChunk;
        }

        originalChunk = nextOriginalChunk;
    }

    cloned.lastChunk = clonedChunk;

    if (this.indentExclusionRanges) {
        cloned.indentExclusionRanges = this.indentExclusionRanges.slice();
    }

    cloned.sourcemapLocations = new BitSet(this.sourcemapLocations);

    cloned.intro = this.intro;
    cloned.outro = this.outro;

    return cloned;
};

MagicString.prototype.generateDecodedMap = function generateDecodedMap(options) {
    var this$1$1 = this;

    options = options || {};

    var sourceIndex = 0;
    var names = Object.keys(this.storedNames);
    var mappings = new Mappings(options.hires);

    var locate = getLocator(this.original);

    if (this.intro) {
        mappings.advance(this.intro);
    }

    this.firstChunk.eachNext(function (chunk) {
        var loc = locate(chunk.start);

        if (chunk.intro.length) { mappings.advance(chunk.intro); }

        if (chunk.edited) {
            mappings.addEdit(
                sourceIndex,
                chunk.content,
                loc,
                chunk.storeName ? names.indexOf(chunk.original) : -1
            );
        } else {
            mappings.addUneditedChunk(sourceIndex, chunk, this$1$1.original, loc, this$1$1.sourcemapLocations);
        }

        if (chunk.outro.length) { mappings.advance(chunk.outro); }
    });

    return {
        file: options.file ? options.file.split(/[/\\]/).pop() : null,
        sources: [options.source ? getRelativePath(options.file || '', options.source) : null],
        sourcesContent: options.includeContent ? [this.original] : [null],
        names: names,
        mappings: mappings.raw,
    };
};

MagicString.prototype.generateMap = function generateMap(options) {
    return new SourceMap(this.generateDecodedMap(options));
};

MagicString.prototype.getIndentString = function getIndentString() {
    return this.indentStr === null ? '\t' : this.indentStr;
};

MagicString.prototype.indent = function indent(indentStr, options) {
    var pattern = /^[^\r\n]/gm;

    if (isObject(indentStr)) {
        options = indentStr;
        indentStr = undefined;
    }

    indentStr = indentStr !== undefined ? indentStr : this.indentStr || '\t';

    if (indentStr === '') { return this; } // noop

    options = options || {};

    // Process exclusion ranges
    var isExcluded = {};

    if (options.exclude) {
        var exclusions =
            typeof options.exclude[0] === 'number' ? [options.exclude] : options.exclude;
        exclusions.forEach(function (exclusion) {
            for (var i = exclusion[0]; i < exclusion[1]; i += 1) {
                isExcluded[i] = true;
            }
        });
    }

    var shouldIndentNextCharacter = options.indentStart !== false;
    var replacer = function (match) {
        if (shouldIndentNextCharacter) { return ("" + indentStr + match); }
        shouldIndentNextCharacter = true;
        return match;
    };

    this.intro = this.intro.replace(pattern, replacer);

    var charIndex = 0;
    var chunk = this.firstChunk;

    while (chunk) {
        var end = chunk.end;

        if (chunk.edited) {
            if (!isExcluded[charIndex]) {
                chunk.content = chunk.content.replace(pattern, replacer);

                if (chunk.content.length) {
                    shouldIndentNextCharacter = chunk.content[chunk.content.length - 1] === '\n';
                }
            }
        } else {
            charIndex = chunk.start;

            while (charIndex < end) {
                if (!isExcluded[charIndex]) {
                    var char = this.original[charIndex];

                    if (char === '\n') {
                        shouldIndentNextCharacter = true;
                    } else if (char !== '\r' && shouldIndentNextCharacter) {
                        shouldIndentNextCharacter = false;

                        if (charIndex === chunk.start) {
                            chunk.prependRight(indentStr);
                        } else {
                            this._splitChunk(chunk, charIndex);
                            chunk = chunk.next;
                            chunk.prependRight(indentStr);
                        }
                    }
                }

                charIndex += 1;
            }
        }

        charIndex = chunk.end;
        chunk = chunk.next;
    }

    this.outro = this.outro.replace(pattern, replacer);

    return this;
};

MagicString.prototype.insert = function insert() {
    throw new Error(
        'magicString.insert(...) is deprecated. Use prependRight(...) or appendLeft(...)'
    );
};

MagicString.prototype.insertLeft = function insertLeft(index, content) {
    if (!warned.insertLeft) {
        console.warn(
            'magicString.insertLeft(...) is deprecated. Use magicString.appendLeft(...) instead'
        ); // eslint-disable-line no-console
        warned.insertLeft = true;
    }

    return this.appendLeft(index, content);
};

MagicString.prototype.insertRight = function insertRight(index, content) {
    if (!warned.insertRight) {
        console.warn(
            'magicString.insertRight(...) is deprecated. Use magicString.prependRight(...) instead'
        ); // eslint-disable-line no-console
        warned.insertRight = true;
    }

    return this.prependRight(index, content);
};

MagicString.prototype.move = function move(start, end, index) {
    if (index >= start && index <= end) { throw new Error('Cannot move a selection inside itself'); }

    this._split(start);
    this._split(end);
    this._split(index);

    var first = this.byStart[start];
    var last = this.byEnd[end];

    var oldLeft = first.previous;
    var oldRight = last.next;

    var newRight = this.byStart[index];
    if (!newRight && last === this.lastChunk) { return this; }
    var newLeft = newRight ? newRight.previous : this.lastChunk;

    if (oldLeft) { oldLeft.next = oldRight; }
    if (oldRight) { oldRight.previous = oldLeft; }

    if (newLeft) { newLeft.next = first; }
    if (newRight) { newRight.previous = last; }

    if (!first.previous) { this.firstChunk = last.next; }
    if (!last.next) {
        this.lastChunk = first.previous;
        this.lastChunk.next = null;
    }

    first.previous = newLeft;
    last.next = newRight || null;

    if (!newLeft) { this.firstChunk = first; }
    if (!newRight) { this.lastChunk = last; }
    return this;
};

MagicString.prototype.overwrite = function overwrite(start, end, content, options) {
    if (typeof content !== 'string') { throw new TypeError('replacement content must be a string'); }

    while (start < 0) { start += this.original.length; }
    while (end < 0) { end += this.original.length; }

    if (end > this.original.length) { throw new Error('end is out of bounds'); }
    if (start === end) {
        throw new Error(
            'Cannot overwrite a zero-length range – use appendLeft or prependRight instead'
        );
    }

    this._split(start);
    this._split(end);

    if (options === true) {
        if (!warned.storeName) {
            console.warn(
                'The final argument to magicString.overwrite(...) should be an options object. See https://github.com/rich-harris/magic-string'
            ); // eslint-disable-line no-console
            warned.storeName = true;
        }

        options = { storeName: true };
    }
    var storeName = options !== undefined ? options.storeName : false;
    var contentOnly = options !== undefined ? options.contentOnly : false;

    if (storeName) {
        var original = this.original.slice(start, end);
        Object.defineProperty(this.storedNames, original, { writable: true, value: true, enumerable: true });
    }

    var first = this.byStart[start];
    var last = this.byEnd[end];

    if (first) {
        var chunk = first;
        while (chunk !== last) {
            if (chunk.next !== this.byStart[chunk.end]) {
                throw new Error('Cannot overwrite across a split point');
            }
            chunk = chunk.next;
            chunk.edit('', false);
        }

        first.edit(content, storeName, contentOnly);
    } else {
        // must be inserting at the end
        var newChunk = new Chunk(start, end, '').edit(content, storeName);

        // TODO last chunk in the array may not be the last chunk, if it's moved...
        last.next = newChunk;
        newChunk.previous = last;
    }
    return this;
};

MagicString.prototype.prepend = function prepend(content) {
    if (typeof content !== 'string') { throw new TypeError('outro content must be a string'); }

    this.intro = content + this.intro;
    return this;
};

MagicString.prototype.prependLeft = function prependLeft(index, content) {
    if (typeof content !== 'string') { throw new TypeError('inserted content must be a string'); }

    this._split(index);

    var chunk = this.byEnd[index];

    if (chunk) {
        chunk.prependLeft(content);
    } else {
        this.intro = content + this.intro;
    }
    return this;
};

MagicString.prototype.prependRight = function prependRight(index, content) {
    if (typeof content !== 'string') { throw new TypeError('inserted content must be a string'); }

    this._split(index);

    var chunk = this.byStart[index];

    if (chunk) {
        chunk.prependRight(content);
    } else {
        this.outro = content + this.outro;
    }
    return this;
};

MagicString.prototype.remove = function remove(start, end) {
    while (start < 0) { start += this.original.length; }
    while (end < 0) { end += this.original.length; }

    if (start === end) { return this; }

    if (start < 0 || end > this.original.length) { throw new Error('Character is out of bounds'); }
    if (start > end) { throw new Error('end must be greater than start'); }

    this._split(start);
    this._split(end);

    var chunk = this.byStart[start];

    while (chunk) {
        chunk.intro = '';
        chunk.outro = '';
        chunk.edit('');

        chunk = end > chunk.end ? this.byStart[chunk.end] : null;
    }
    return this;
};

MagicString.prototype.lastChar = function lastChar() {
    if (this.outro.length) { return this.outro[this.outro.length - 1]; }
    var chunk = this.lastChunk;
    do {
        if (chunk.outro.length) { return chunk.outro[chunk.outro.length - 1]; }
        if (chunk.content.length) { return chunk.content[chunk.content.length - 1]; }
        if (chunk.intro.length) { return chunk.intro[chunk.intro.length - 1]; }
    } while ((chunk = chunk.previous));
    if (this.intro.length) { return this.intro[this.intro.length - 1]; }
    return '';
};

MagicString.prototype.lastLine = function lastLine() {
    var lineIndex = this.outro.lastIndexOf(n);
    if (lineIndex !== -1) { return this.outro.substr(lineIndex + 1); }
    var lineStr = this.outro;
    var chunk = this.lastChunk;
    do {
        if (chunk.outro.length > 0) {
            lineIndex = chunk.outro.lastIndexOf(n);
            if (lineIndex !== -1) { return chunk.outro.substr(lineIndex + 1) + lineStr; }
            lineStr = chunk.outro + lineStr;
        }

        if (chunk.content.length > 0) {
            lineIndex = chunk.content.lastIndexOf(n);
            if (lineIndex !== -1) { return chunk.content.substr(lineIndex + 1) + lineStr; }
            lineStr = chunk.content + lineStr;
        }

        if (chunk.intro.length > 0) {
            lineIndex = chunk.intro.lastIndexOf(n);
            if (lineIndex !== -1) { return chunk.intro.substr(lineIndex + 1) + lineStr; }
            lineStr = chunk.intro + lineStr;
        }
    } while ((chunk = chunk.previous));
    lineIndex = this.intro.lastIndexOf(n);
    if (lineIndex !== -1) { return this.intro.substr(lineIndex + 1) + lineStr; }
    return this.intro + lineStr;
};

MagicString.prototype.slice = function slice(start, end) {
    if (start === void 0) start = 0;
    if (end === void 0) end = this.original.length;

    while (start < 0) { start += this.original.length; }
    while (end < 0) { end += this.original.length; }

    var result = '';

    // find start chunk
    var chunk = this.firstChunk;
    while (chunk && (chunk.start > start || chunk.end <= start)) {
        // found end chunk before start
        if (chunk.start < end && chunk.end >= end) {
            return result;
        }

        chunk = chunk.next;
    }

    if (chunk && chunk.edited && chunk.start !== start) { throw new Error(("Cannot use replaced character " + start + " as slice start anchor.")); }

    var startChunk = chunk;
    while (chunk) {
        if (chunk.intro && (startChunk !== chunk || chunk.start === start)) {
            result += chunk.intro;
        }

        var containsEnd = chunk.start < end && chunk.end >= end;
        if (containsEnd && chunk.edited && chunk.end !== end) { throw new Error(("Cannot use replaced character " + end + " as slice end anchor.")); }

        var sliceStart = startChunk === chunk ? start - chunk.start : 0;
        var sliceEnd = containsEnd ? chunk.content.length + end - chunk.end : chunk.content.length;

        result += chunk.content.slice(sliceStart, sliceEnd);

        if (chunk.outro && (!containsEnd || chunk.end === end)) {
            result += chunk.outro;
        }

        if (containsEnd) {
            break;
        }

        chunk = chunk.next;
    }

    return result;
};

// TODO deprecate this? not really very useful
MagicString.prototype.snip = function snip(start, end) {
    var clone = this.clone();
    clone.remove(0, start);
    clone.remove(end, clone.original.length);

    return clone;
};

MagicString.prototype._split = function _split(index) {
    if (this.byStart[index] || this.byEnd[index]) { return; }

    var chunk = this.lastSearchedChunk;
    var searchForward = index > chunk.end;

    while (chunk) {
        if (chunk.contains(index)) { return this._splitChunk(chunk, index); }

        chunk = searchForward ? this.byStart[chunk.end] : this.byEnd[chunk.start];
    }
};

MagicString.prototype._splitChunk = function _splitChunk(chunk, index) {
    if (chunk.edited && chunk.content.length) {
        // zero-length edited chunks are a special case (overlapping replacements)
        var loc = getLocator(this.original)(index);
        throw new Error(
            ("Cannot split a chunk that has already been edited (" + (loc.line) + ":" + (loc.column) + " – \"" + (chunk.original) + "\")")
        );
    }

    var newChunk = chunk.split(index);

    this.byEnd[index] = chunk;
    this.byStart[index] = newChunk;
    this.byEnd[newChunk.end] = newChunk;

    if (chunk === this.lastChunk) { this.lastChunk = newChunk; }

    this.lastSearchedChunk = chunk;
    return true;
};

MagicString.prototype.toString = function toString() {
    var str = this.intro;

    var chunk = this.firstChunk;
    while (chunk) {
        str += chunk.toString();
        chunk = chunk.next;
    }

    return str + this.outro;
};

MagicString.prototype.isEmpty = function isEmpty() {
    var chunk = this.firstChunk;
    do {
        if (
            (chunk.intro.length && chunk.intro.trim()) ||
            (chunk.content.length && chunk.content.trim()) ||
            (chunk.outro.length && chunk.outro.trim())
        ) { return false; }
    } while ((chunk = chunk.next));
    return true;
};

MagicString.prototype.length = function length() {
    var chunk = this.firstChunk;
    var length = 0;
    do {
        length += chunk.intro.length + chunk.content.length + chunk.outro.length;
    } while ((chunk = chunk.next));
    return length;
};

MagicString.prototype.trimLines = function trimLines() {
    return this.trim('[\\r\\n]');
};

MagicString.prototype.trim = function trim(charType) {
    return this.trimStart(charType).trimEnd(charType);
};

MagicString.prototype.trimEndAborted = function trimEndAborted(charType) {
    var rx = new RegExp((charType || '\\s') + '+$');

    this.outro = this.outro.replace(rx, '');
    if (this.outro.length) { return true; }

    var chunk = this.lastChunk;

    do {
        var end = chunk.end;
        var aborted = chunk.trimEnd(rx);

        // if chunk was trimmed, we have a new lastChunk
        if (chunk.end !== end) {
            if (this.lastChunk === chunk) {
                this.lastChunk = chunk.next;
            }

            this.byEnd[chunk.end] = chunk;
            this.byStart[chunk.next.start] = chunk.next;
            this.byEnd[chunk.next.end] = chunk.next;
        }

        if (aborted) { return true; }
        chunk = chunk.previous;
    } while (chunk);

    return false;
};

MagicString.prototype.trimEnd = function trimEnd(charType) {
    this.trimEndAborted(charType);
    return this;
};
MagicString.prototype.trimStartAborted = function trimStartAborted(charType) {
    var rx = new RegExp('^' + (charType || '\\s') + '+');

    this.intro = this.intro.replace(rx, '');
    if (this.intro.length) { return true; }

    var chunk = this.firstChunk;

    do {
        var end = chunk.end;
        var aborted = chunk.trimStart(rx);

        if (chunk.end !== end) {
            // special case...
            if (chunk === this.lastChunk) { this.lastChunk = chunk.next; }

            this.byEnd[chunk.end] = chunk;
            this.byStart[chunk.next.start] = chunk.next;
            this.byEnd[chunk.next.end] = chunk.next;
        }

        if (aborted) { return true; }
        chunk = chunk.next;
    } while (chunk);

    return false;
};

MagicString.prototype.trimStart = function trimStart(charType) {
    this.trimStartAborted(charType);
    return this;
};

function findDependencies(id, sets, sharedModuleIds, usedSharedModuleIds) {
    if (!sets.has(id)) {
        sets.add(id);
        const moduleInfo = this.getModuleInfo(id);
        if (moduleInfo === null || moduleInfo === void 0 ? void 0 : moduleInfo.importedIds) {
            moduleInfo.importedIds.forEach((id) => {
                findDependencies.apply(this, [
                    id,
                    sets,
                    sharedModuleIds,
                    usedSharedModuleIds
                ]);
            });
        }
        if (sharedModuleIds.has(id)) {
            usedSharedModuleIds.add(sharedModuleIds.get(id));
        }
    }
}
function parseSharedOptions(options) {
    return parseOptions(options.shared || {}, (value, key) => ({
        import: true,
        shareScope: 'default',
        packagePath: key,
        // Whether the path is set manually
        manuallyPackagePathSetting: true
    }), (value, key) => {
        var _a;
        value.import = (_a = value.import) !== null && _a !== void 0 ? _a : true;
        value.shareScope = value.shareScope || 'default';
        value.packagePath = value.packagePath || key;
        value.manuallyPackagePathSetting = value.packagePath !== key;
        return value;
    });
}
function parseExposeOptions(options) {
    return parseOptions(options.exposes, (item) => {
        return {
            import: item,
            name: undefined
        };
    }, (item) => ({
        import: item.import,
        name: item.name || undefined
    }));
}
function parseRemoteOptions(options) {
    return parseOptions(options.remotes ? options.remotes : {}, (item) => ({
        external: Array.isArray(item) ? item : [item],
        shareScope: options.shareScope || 'default',
        format: 'esm',
        from: 'vite',
        externalType: 'url'
    }), (item) => {
        var _a;
        return ({
            external: Array.isArray(item.external) ? item.external : [item.external],
            shareScope: item.shareScope || options.shareScope || 'default',
            format: item.format || 'esm',
            from: (_a = item.from) !== null && _a !== void 0 ? _a : 'vite',
            externalType: item.externalType || 'url'
        });
    });
}
function parseOptions(options, normalizeSimple, normalizeOptions) {
    if (!options) {
        return [];
    }
    const list = [];
    const array = (items) => {
        for (const item of items) {
            if (typeof item === 'string') {
                list.push([item, normalizeSimple(item, item)]);
            }
            else if (item && typeof item === 'object') {
                object(item);
            }
            else {
                throw new Error('Unexpected options format');
            }
        }
    };
    const object = (obj) => {
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' || Array.isArray(value)) {
                list.push([key, normalizeSimple(value, key)]);
            }
            else {
                list.push([key, normalizeOptions(value, key)]);
            }
        }
    };
    if (Array.isArray(options)) {
        array(options);
    }
    else if (typeof options === 'object') {
        object(options);
    }
    else {
        throw new Error('Unexpected options format');
    }
    return list;
}
const letterReg = new RegExp('[0-9a-zA-Z]+');
function removeNonRegLetter(str, reg = letterReg) {
    let needUpperCase = false;
    let ret = '';
    for (const c of str) {
        if (reg.test(c)) {
            ret += needUpperCase ? c.toUpperCase() : c;
            needUpperCase = false;
        }
        else {
            needUpperCase = true;
        }
    }
    return ret;
}
function getModuleMarker(value, type) {
    return type ? `__rf_${type}__${value}` : `__rf_placeholder__${value}`;
}
function normalizePath(id) {
    return posix.normalize(id.replace(/\\/g, '/'));
}
function createRemotesMap(remotes) {
    const createUrl = (remote) => {
        const external = remote.config.external[0];
        const externalType = remote.config.externalType;
        if (externalType === 'promise') {
            return `()=>${external}`;
        }
        else {
            return `'${external}'`;
        }
    };
    return `const remotesMap = {
${remotes
            .map((remote) => `'${remote.id}':{url:${createUrl(remote)},format:'${remote.config.format}',from:'${remote.config.from}'}`)
            .join(',\n  ')}
};`;
}
const REMOTE_FROM_PARAMETER = 'remoteFrom';
const NAME_CHAR_REG = new RegExp('[0-9a-zA-Z@_-]+');

// for generateBundle Hook replace
const EXPOSES_MAP = new Map();
const EXPOSES_KEY_MAP = new Map();
const SHARED = 'shared';
const DYNAMIC_LOADING_CSS = 'dynamicLoadingCss';
const DYNAMIC_LOADING_CSS_PREFIX = '__v__css__';
const DEFAULT_ENTRY_FILENAME = 'remoteEntry.js';
const builderInfo = {
    builder: 'rollup',
    version: '',
    assetsDir: '',
    isHost: false,
    isRemote: false,
    isShared: false
};
const parsedOptions = {
    prodExpose: [],
    prodRemote: [],
    prodShared: [],
    devShared: [],
    devExpose: [],
    devRemote: []
};

const sharedFileName2Prop = new Map();
function prodRemotePlugin(options) {
    parsedOptions.prodRemote = parseRemoteOptions(options);
    const remotes = [];
    for (const item of parsedOptions.prodRemote) {
        remotes.push({
            id: item[0],
            regexp: new RegExp(`^${item[0]}/.+?`),
            config: item[1]
        });
    }
    return {
        name: 'originjs:remote-production',
        virtualFile: {
            // language=JS
            __federation__: `
${createRemotesMap(remotes)}
const loadJS = async (url, fn) => {
  const resolvedUrl = typeof url === 'function' ? await url() : url;
  const script = document.createElement('script')
  script.type = 'text/javascript';
  script.onload = fn;
  script.src = resolvedUrl;
  document.getElementsByTagName('head')[0].appendChild(script);
}
const scriptTypes = ['var'];
const importTypes = ['esm', 'systemjs']
function get(name, ${REMOTE_FROM_PARAMETER}){
  return __federation_import(name).then(module => ()=> {
    if (${REMOTE_FROM_PARAMETER} === 'webpack') {
      return Object.prototype.toString.call(module).indexOf('Module') > -1 && module.default ? module.default : module
    }
    return module
  })
}
const wrapShareModule = ${REMOTE_FROM_PARAMETER} => {
  return {
    ${getModuleMarker('shareScope')}
  }
}
async function __federation_import(name){
  return import(name);
}
const initMap = Object.create(null);
async function __federation_method_ensure(remoteId) {
  const remote = remotesMap[remoteId];
  if (!remote.inited) {
    if (scriptTypes.includes(remote.format)) {
      // loading js with script tag
      return new Promise(resolve => {
        const callback = () => {
          if (!remote.inited) {
            remote.lib = window[remoteId];
            remote.lib.init(wrapShareModule(remote.from))
            remote.inited = true;
          }
          resolve(remote.lib);
        }
        return loadJS(remote.url, callback);
      });
    } else if (importTypes.includes(remote.format)) {
      // loading js with import(...)
      return new Promise(resolve => {
        const getUrl = typeof remote.url === 'function' ? remote.url : () => Promise.resolve(remote.url);
        getUrl().then(url => {
          import(/* @vite-ignore */ url).then(lib => {
            if (!remote.inited) {
              const shareScope = wrapShareModule(remote.from)
              lib.init(shareScope);
              remote.lib = lib;
              remote.lib.init(shareScope);
              remote.inited = true;
            }
            resolve(remote.lib);
          })
        })
      })
    }
  } else {
    return remote.lib;
  }
}

function __federation_method_unwrapDefault(module) {
  return (module?.__esModule || module?.[Symbol.toStringTag] === 'Module')?module.default:module
}

function __federation_method_wrapDefault(module ,need){
  if (!module?.default && need) {
    let obj = Object.create(null);
    obj.default = module;
    obj.__esModule = true;
    return obj;
  }
  return module; 
}

function __federation_method_getRemote(remoteName,  componentName){
  return __federation_method_ensure(remoteName).then((remote) => remote.get(componentName).then(factory => factory()));
}
export {__federation_method_ensure, __federation_method_getRemote , __federation_method_unwrapDefault , __federation_method_wrapDefault}
`
        },
        async transform(code, id) {
            var _a, _b, _c;
            if (builderInfo.isShared) {
                for (const sharedInfo of parsedOptions.prodShared) {
                    if (!sharedInfo[1].emitFile) {
                        const basename = `__federation_shared_${removeNonRegLetter(sharedInfo[0], NAME_CHAR_REG)}.js`;
                        sharedInfo[1].emitFile = this.emitFile({
                            type: 'chunk',
                            id: (_a = sharedInfo[1].id) !== null && _a !== void 0 ? _a : sharedInfo[1].packagePath,
                            fileName: `${builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''}${sharedInfo[1].root ? sharedInfo[1].root[0] + '/' : ''}${basename}`,
                            preserveSignature: 'allow-extension'
                        });
                        sharedFileName2Prop.set(basename, sharedInfo);
                    }
                }
                if (id === '\0virtual:__federation_fn_import') {
                    const moduleMapCode = parsedOptions.prodShared
                        .map((sharedInfo) => `'${sharedInfo[0]}':{get:()=>()=>__federation_import('./${sharedInfo[1].root ? `${sharedInfo[1].root[0]}/` : ''}${basename(this.getFileName(sharedInfo[1].emitFile))}'),import:${sharedInfo[1].import}${sharedInfo[1].requiredVersion
                            ? `,requiredVersion:'${sharedInfo[1].requiredVersion}'`
                            : ''}}`)
                        .join(',');
                    return code.replace(getModuleMarker('moduleMap', 'var'), `{${moduleMapCode}}`);
                }
                if (id === '\0virtual:__federation_lib_semver') {
                    const federationId = (_b = (await this.resolve('@originjs/vite-plugin-federation'))) === null || _b === void 0 ? void 0 : _b.id;
                    const satisfyId = `${dirname(federationId)}/satisfy.js`;
                    return readFileSync(satisfyId, { encoding: 'utf-8' });
                }
            }
            if (builderInfo.isRemote) {
                for (const expose of parsedOptions.prodExpose) {
                    if (!expose[1].emitFile) {
                        if (!expose[1].id) {
                            // resolved the moduleId here for the reference somewhere else like #152
                            expose[1].id = (_c = (await this.resolve(expose[1].import))) === null || _c === void 0 ? void 0 : _c.id;
                        }
                        expose[1].emitFile = this.emitFile({
                            type: 'chunk',
                            id: expose[1].id,
                            name: EXPOSES_KEY_MAP.get(expose[0]),
                            preserveSignature: 'allow-extension'
                        });
                    }
                }
            }
            if (builderInfo.isHost) {
                if (id === '\0virtual:__federation__') {
                    const res = [];
                    parsedOptions.prodShared.forEach((arr) => {
                        const obj = arr[1];
                        let str = '';
                        if (typeof obj === 'object') {
                            const fileName = `./${basename(this.getFileName(obj.emitFile))}`;
                            str += `get:()=>get('${fileName}', ${REMOTE_FROM_PARAMETER}), loaded:1`;
                            res.push(`'${arr[0]}':{'${obj.version}':{${str}}}`);
                        }
                    });
                    return code.replace(getModuleMarker('shareScope'), res.join(','));
                }
                let ast = null;
                try {
                    ast = this.parse(code);
                }
                catch (err) {
                    console.error(err);
                }
                if (!ast) {
                    return null;
                }
                const magicString = new MagicString(code);
                const hasStaticImported = new Map();
                let requiresRuntime = false;
                walk(ast, {
                    enter(node) {
                        var _a, _b, _c;
                        if ((node.type === 'ImportExpression' ||
                            node.type === 'ImportDeclaration' ||
                            node.type === 'ExportNamedDeclaration') &&
                            ((_b = (_a = node.source) === null || _a === void 0 ? void 0 : _a.value) === null || _b === void 0 ? void 0 : _b.indexOf('/')) > -1) {
                            const moduleId = node.source.value;
                            const remote = remotes.find((r) => r.regexp.test(moduleId));
                            const needWrap = (remote === null || remote === void 0 ? void 0 : remote.config.from) === 'vite';
                            if (remote) {
                                requiresRuntime = true;
                                const modName = `.${moduleId.slice(remote.id.length)}`;
                                switch (node.type) {
                                    case 'ImportExpression': {
                                        magicString.overwrite(node.start, node.end, `__federation_method_getRemote(${JSON.stringify(remote.id)} , ${JSON.stringify(modName)}).then(module=>__federation_method_wrapDefault(module, ${needWrap}))`);
                                        break;
                                    }
                                    case 'ImportDeclaration': {
                                        if ((_c = node.specifiers) === null || _c === void 0 ? void 0 : _c.length) {
                                            const afterImportName = `__federation_var_${moduleId.replace(/[@/\\.-]/g, '')}`;
                                            if (!hasStaticImported.has(moduleId)) {
                                                hasStaticImported.set(moduleId, afterImportName);
                                                magicString.overwrite(node.start, node.end, `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(remote.id)} , ${JSON.stringify(modName)});`);
                                            }
                                            let deconstructStr = '';
                                            node.specifiers.forEach((spec) => {
                                                // default import , like import a from 'lib'
                                                if (spec.type === 'ImportDefaultSpecifier') {
                                                    magicString.appendRight(node.end, `\n let ${spec.local.name} = __federation_method_unwrapDefault(${afterImportName}) `);
                                                }
                                                else if (spec.type === 'ImportSpecifier') {
                                                    //  like import {a as b} from 'lib'
                                                    const importedName = spec.imported.name;
                                                    const localName = spec.local.name;
                                                    deconstructStr += `${importedName === localName
                                                        ? localName
                                                        : `${importedName} : ${localName}`},`;
                                                }
                                                else if (spec.type === 'ImportNamespaceSpecifier') {
                                                    //  like import * as a from 'lib'
                                                    magicString.appendRight(node.end, `let {${spec.local.name}} = ${afterImportName}`);
                                                }
                                            });
                                            if (deconstructStr.length > 0) {
                                                magicString.appendRight(node.end, `\n let {${deconstructStr.slice(0, -1)}} = ${afterImportName}`);
                                            }
                                        }
                                        break;
                                    }
                                    case 'ExportNamedDeclaration': {
                                        // handle export like export {a} from 'remotes/lib'
                                        const afterImportName = `__federation_var_${moduleId.replace(/[@/\\.-]/g, '')}`;
                                        if (!hasStaticImported.has(moduleId)) {
                                            hasStaticImported.set(moduleId, afterImportName);
                                            magicString.overwrite(node.start, node.end, `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(remote.id)} , ${JSON.stringify(modName)});`);
                                        }
                                        if (node.specifiers.length > 0) {
                                            const specifiers = node.specifiers;
                                            let exportContent = '';
                                            let deconstructContent = '';
                                            specifiers.forEach((spec) => {
                                                const localName = spec.local.name;
                                                const exportName = spec.exported.name;
                                                const variableName = `${afterImportName}_${localName}`;
                                                deconstructContent = deconstructContent.concat(`${localName}:${variableName},`);
                                                exportContent = exportContent.concat(`${variableName} as ${exportName},`);
                                            });
                                            magicString.append(`\n const {${deconstructContent.slice(0, deconstructContent.length - 1)}} = ${afterImportName}; \n`);
                                            magicString.append(`\n export {${exportContent.slice(0, exportContent.length - 1)}}; `);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                });
                if (requiresRuntime) {
                    magicString.prepend(`import {__federation_method_ensure, __federation_method_getRemote , __federation_method_wrapDefault , __federation_method_unwrapDefault} from '__federation__';\n\n`);
                }
                return magicString.toString();
            }
        }
    };
}

const sharedFileReg = /^__federation_shared_.+\.js$/;
function prodSharedPlugin(options) {
    parsedOptions.prodShared = parseSharedOptions(options);
    const shareName2Prop = new Map();
    parsedOptions.prodShared.forEach((value) => shareName2Prop.set(value[0], value[1]));
    const exposesModuleIdSet = new Set();
    EXPOSES_MAP.forEach((value) => {
        exposesModuleIdSet.add(`${value}.js`);
    });
    let isHost;
    let isRemote;
    const id2Prop = new Map();
    const moduleCheckedSet = new Set();
    const moduleNeedToTransformSet = new Set(); // record modules that import shard libs, and refered in chunk tranform logic
    const transformImportFn = function (code, chunk, options) {
        const ast = this.parse(code);
        const magicString = new MagicString(code);
        let modify = false;
        switch (options.format) {
            case 'es':
                {
                    walk(ast, {
                        enter(node) {
                            var _a, _b;
                            if (node.type === 'ImportDeclaration' &&
                                sharedFileReg.test(basename(node.source.value))) {
                                const sharedName = (_a = sharedFileName2Prop.get(basename(node.source.value))) === null || _a === void 0 ? void 0 : _a[0];
                                if (sharedName) {
                                    const declaration = [];
                                    (_b = node.specifiers) === null || _b === void 0 ? void 0 : _b.forEach((specify) => {
                                        var _a;
                                        declaration.push(`${((_a = specify.imported) === null || _a === void 0 ? void 0 : _a.name)
                                            ? `${specify.imported.name === specify.local.name
                                                ? specify.local.name
                                                : `${specify.imported.name}:${specify.local.name}`}`
                                            : `default:${specify.local.name}`}`);
                                    });
                                    if (declaration.length) {
                                        magicString.overwrite(node.start, node.end, `const {${declaration.join(',')}} = await importShared('${sharedName}')`);
                                        modify = true;
                                    }
                                }
                            }
                        }
                    });
                    if (modify) {
                        const prop = id2Prop.get(chunk.facadeModuleId);
                        magicString.prepend(`import {importShared} from '${(prop === null || prop === void 0 ? void 0 : prop.root) ? '.' : ''}./__federation_fn_import.js'\n`);
                        return {
                            code: magicString.toString(),
                            map: magicString.generateMap(chunk.map)
                        };
                    }
                }
                break;
            case 'system':
                {
                    walk(ast, {
                        enter(node) {
                            var _a, _b, _c, _d, _e;
                            const expression = node.body.length === 1
                                ? (_a = node.body[0]) === null || _a === void 0 ? void 0 : _a.expression
                                : (_b = node.body.find((item) => {
                                    var _a, _b, _c, _d;
                                    return item.type === 'ExpressionStatement' &&
                                        ((_c = (_b = (_a = item.expression) === null || _a === void 0 ? void 0 : _a.callee) === null || _b === void 0 ? void 0 : _b.object) === null || _c === void 0 ? void 0 : _c.name) === 'System' &&
                                        ((_d = item.expression.callee.property) === null || _d === void 0 ? void 0 : _d.name) === 'register';
                                })) === null || _b === void 0 ? void 0 : _b.expression;
                            if (expression) {
                                const args = expression.arguments;
                                if (args[0].type === 'ArrayExpression' &&
                                    ((_c = args[0].elements) === null || _c === void 0 ? void 0 : _c.length) > 0) {
                                    const importIndex = [];
                                    let removeLast = false;
                                    chunk.imports.forEach((importName, index) => {
                                        var _a;
                                        const baseName = basename(importName);
                                        if (sharedFileReg.test(baseName)) {
                                            importIndex.push({
                                                index: index,
                                                name: (_a = sharedFileName2Prop.get(baseName)) === null || _a === void 0 ? void 0 : _a[0]
                                            });
                                            if (index === chunk.imports.length - 1) {
                                                removeLast = true;
                                            }
                                        }
                                    });
                                    if (importIndex.length &&
                                        ((_d = args[1]) === null || _d === void 0 ? void 0 : _d.type) === 'FunctionExpression') {
                                        const functionExpression = args[1];
                                        const returnStatement = (_e = functionExpression === null || functionExpression === void 0 ? void 0 : functionExpression.body) === null || _e === void 0 ? void 0 : _e.body.find((item) => item.type === 'ReturnStatement');
                                        if (returnStatement) {
                                            // insert __federation_import variable
                                            magicString.prependLeft(returnStatement.start, 'var __federation_import;\n');
                                            const setters = returnStatement.argument.properties.find((property) => property.key.name === 'setters');
                                            const settersElements = setters.value.elements;
                                            // insert __federation_import setter
                                            magicString.appendRight(setters.end - 1, `${removeLast ? '' : ','}function (module){__federation_import=module.importShared}`);
                                            const execute = returnStatement.argument.properties.find((property) => property.key.name === 'execute');
                                            const insertPos = execute.value.body.body[0].start;
                                            importIndex.forEach((item) => {
                                                // remove unnecessary setters and import
                                                const last = item.index === settersElements.length - 1;
                                                magicString.remove(settersElements[item.index].start, last
                                                    ? settersElements[item.index].end
                                                    : settersElements[item.index + 1].start - 1);
                                                magicString.remove(args[0].elements[item.index].start, last
                                                    ? args[0].elements[item.index].end
                                                    : args[0].elements[item.index + 1].start - 1);
                                                // insert federation shared import lib
                                                const varName = `__federation_${removeNonRegLetter(item.name)}`;
                                                magicString.prependLeft(insertPos, `var  ${varName} = await __federation_import('${item.name}');\n`);
                                                // replace it with sharedImport
                                                setters.value.elements[item.index].body.body.forEach((setFn) => {
                                                    var _a;
                                                    magicString.appendLeft(insertPos, `${setFn.expression.left.name} = ${varName}.${(_a = setFn.expression.right.property.name) !== null && _a !== void 0 ? _a : setFn.expression.right.property.value};\n`);
                                                });
                                            });
                                            // add async flag to execute function
                                            magicString.prependLeft(execute.value.start, ' async ');
                                            // add sharedImport import declaration
                                            magicString.appendRight(args[0].end - 1, `${removeLast ? '' : ','}'./__federation_fn_import.js'`);
                                            modify = true;
                                        }
                                    }
                                }
                            }
                            // only need to process once
                            this.skip();
                        }
                    });
                    if (modify) {
                        return {
                            code: magicString.toString(),
                            map: magicString.generateMap(chunk.map)
                        };
                    }
                }
                break;
        }
    };
    return {
        name: 'originjs:shared-production',
        virtualFile: {
            __federation_lib_semver: 'void 0',
            __federation_fn_import: `
      const moduleMap= ${getModuleMarker('moduleMap', 'var')}
      const moduleCache = Object.create(null);
      async function importShared(name,shareScope = 'default') {
        return moduleCache[name] ? new Promise((r) => r(moduleCache[name])) : (await getSharedFromRuntime(name, shareScope) || getSharedFromLocal(name));
      }
      async function __federation_import(name){
        return import(name);
      }
      async function getSharedFromRuntime(name,shareScope) {
        let module = null;
        if (globalThis?.__federation_shared__?.[shareScope]?.[name]) {
          const versionObj = globalThis.__federation_shared__[shareScope][name];
          const versionKey = Object.keys(versionObj)[0];
          const versionValue = Object.values(versionObj)[0];
          if (moduleMap[name]?.requiredVersion) {
            // judge version satisfy
            const semver= await import('__federation_lib_semver');
            const fn = semver.satisfy;
            if (fn(versionKey, moduleMap[name].requiredVersion)) {
               module = (await versionValue.get())();
            } else {
              console.log(\`provider support \${name}(\${versionKey}) is not satisfied requiredVersion(\${moduleMap[name].requiredVersion})\`)
            }
          } else {
            module = (await versionValue.get())();
          }
        }
        if(module){
          moduleCache[name] = module;
          return module;
        }
      }
      async function getSharedFromLocal(name , shareScope) {
        if (moduleMap[name]?.import) {
          const module = (await moduleMap[name].get())()
          moduleCache[name] = module;
          return module;
        } else {
          console.error(\`consumer config import=false,so cant use callback shared module\`)
        }
      }
      export {importShared , getSharedFromRuntime as importSharedRuntime , getSharedFromLocal as importSharedLocal};
      `
        },
        options(inputOptions) {
            var _a;
            isHost = !!parsedOptions.prodRemote.length;
            isRemote = !!parsedOptions.prodExpose.length;
            if (shareName2Prop.size) {
                // remove item which is both in external and shared
                inputOptions.external = (_a = inputOptions.external) === null || _a === void 0 ? void 0 : _a.filter((item) => {
                    return !shareName2Prop.has(item);
                });
            }
            return inputOptions;
        },
        async buildStart() {
            // forEach and collect dir
            const collectDirFn = (filePath, collect) => {
                const files = readdirSync(filePath);
                files.forEach((name) => {
                    const tempPath = join(filePath, name);
                    const isDir = statSync(tempPath).isDirectory();
                    if (isDir) {
                        collect.push(tempPath);
                        collectDirFn(tempPath, collect);
                    }
                });
            };
            const monoRepos = [];
            const dirPaths = [];
            const currentDir = resolve();
            for (const arr of parsedOptions.prodShared) {
                try {
                    const resolve = await this.resolve(arr[1].packagePath);
                    arr[1].id = resolve === null || resolve === void 0 ? void 0 : resolve.id;
                }
                catch (e) {
                    //    try to resolve monoRepo
                    if (!arr[1].manuallyPackagePathSetting) {
                        arr[1].removed = true;
                        const dir = join(currentDir, 'node_modules', arr[0]);
                        const dirStat = statSync(dir);
                        if (dirStat.isDirectory()) {
                            collectDirFn(dir, dirPaths);
                        }
                        else {
                            this.error(`cant resolve "${arr[1].packagePath}"`);
                        }
                        if (dirPaths.length > 0) {
                            monoRepos.push({ arr: dirPaths, root: arr });
                        }
                    }
                }
                if (isHost && !arr[1].manuallyPackagePathSetting && !arr[1].version) {
                    const packageJsonPath = `${currentDir}${sep}node_modules${sep}${arr[0]}${sep}package.json`;
                    arr[1].version = (await import(packageJsonPath)).version;
                    if (!arr[1].version) {
                        this.error(`No description file or no version in description file (usually package.json) of ${arr[0]}(${packageJsonPath}). Add version to description file, or manually specify version in shared config.`);
                    }
                }
            }
            parsedOptions.prodShared = parsedOptions.prodShared.filter((item) => !item[1].removed);
            // assign version to monoRepo
            if (monoRepos.length > 0) {
                for (const monoRepo of monoRepos) {
                    for (const id of monoRepo.arr) {
                        try {
                            const idResolve = await this.resolve(id);
                            if (idResolve === null || idResolve === void 0 ? void 0 : idResolve.id) {
                                parsedOptions.prodShared.push([
                                    `${monoRepo.root[0]}/${basename(id)}`,
                                    {
                                        id: idResolve === null || idResolve === void 0 ? void 0 : idResolve.id,
                                        import: monoRepo.root[1].import,
                                        shareScope: monoRepo.root[1].shareScope,
                                        root: monoRepo.root
                                    }
                                ]);
                            }
                        }
                        catch (e) {
                            //    ignore
                        }
                    }
                }
            }
            if (parsedOptions.prodShared.length && isRemote) {
                for (const prod of parsedOptions.prodShared) {
                    id2Prop.set(prod[1].id, prod[1]);
                }
                this.emitFile({
                    fileName: `${builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''}__federation_fn_import.js`,
                    type: 'chunk',
                    id: '__federation_fn_import',
                    preserveSignature: 'strict'
                });
                this.emitFile({
                    fileName: `${builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''}__federation_lib_semver.js`,
                    type: 'chunk',
                    id: '__federation_lib_semver',
                    preserveSignature: 'strict'
                });
            }
        },
        outputOptions: function (outputOption) {
            // remove rollup generated empty imports,like import './filename.js'
            outputOption.hoistTransitiveImports = false;
            // sort shared dep
            const that = this;
            const priority = [];
            const depInShared = new Map();
            parsedOptions.prodShared.forEach((value) => {
                const shareName = value[0];
                // pick every shared moduleId
                const usedSharedModuleIds = new Set();
                const sharedModuleIds = new Map();
                // exclude itself
                parsedOptions.prodShared
                    .filter((item) => item[0] !== shareName)
                    .forEach((item) => sharedModuleIds.set(item[1].id, item[0]));
                depInShared.set(shareName, usedSharedModuleIds);
                const deps = new Set();
                findDependencies.apply(that, [
                    value[1].id,
                    deps,
                    sharedModuleIds,
                    usedSharedModuleIds
                ]);
                value[1].dependencies = deps;
            });
            // judge dependencies priority
            const orderByDepCount = [];
            depInShared.forEach((value, key) => {
                if (!orderByDepCount[value.size]) {
                    orderByDepCount[value.size] = new Map();
                }
                orderByDepCount[value.size].set(key, value);
            });
            // dependency nothing is first,handle index = 0
            if (orderByDepCount[0]) {
                for (const key of orderByDepCount[0].keys()) {
                    priority.push(key);
                }
            }
            // handle index >= 1
            orderByDepCount
                .filter((item, index) => item && index >= 1)
                .forEach((item) => {
                    for (const entry of item.entries()) {
                        addDep(entry, priority, depInShared);
                    }
                });
            function addDep([key, value], priority, depInShared) {
                for (const dep of value) {
                    if (!priority.includes(dep)) {
                        addDep([dep, depInShared.get(dep)], priority, depInShared);
                    }
                }
                if (!priority.includes(key)) {
                    priority.push(key);
                }
            }
            // adjust the map order according to priority
            parsedOptions.prodShared.sort((a, b) => {
                const aIndex = priority.findIndex((value) => value === a[0]);
                const bIndex = priority.findIndex((value) => value === b[0]);
                return aIndex - bIndex;
            });
            const manualChunkFunc = (id) => {
                //  if id is in shared dependencies, return id ,else return vite function value
                const find = parsedOptions.prodShared.find((arr) => { var _a; return (_a = arr[1].dependencies) === null || _a === void 0 ? void 0 : _a.has(id); });
                return find ? find[0] : undefined;
            };
            // only active when manualChunks is function,array not to solve
            if (typeof outputOption.manualChunks === 'function') {
                outputOption.manualChunks = new Proxy(outputOption.manualChunks, {
                    apply(target, thisArg, argArray) {
                        const result = manualChunkFunc(argArray[0]);
                        return result ? result : target(argArray[0], argArray[1]);
                    }
                });
            }
            // The default manualChunk function is no longer available from vite 2.9.0
            if (outputOption.manualChunks === undefined) {
                outputOption.manualChunks = manualChunkFunc;
            }
            // handle expose component import other components which may import shared
            if (isRemote &&
                parsedOptions.prodShared.length &&
                parsedOptions.prodExpose.length) {
                // start collect exposed modules and their dependency modules which imported shared libs
                const exposedModuleIds = parsedOptions.prodExpose
                    .filter((item) => { var _a; return !!((_a = item === null || item === void 0 ? void 0 : item[1]) === null || _a === void 0 ? void 0 : _a.id); })
                    .map((item) => item[1]['id']);
                const sharedLibIds = new Set(parsedOptions.prodShared
                    .map((item) => { var _a; return (_a = item === null || item === void 0 ? void 0 : item[1]) === null || _a === void 0 ? void 0 : _a.id; })
                    .filter((item) => !!item));
                const addDeps = (id) => {
                    if (moduleCheckedSet.has(id))
                        return;
                    moduleCheckedSet.add(id);
                    const info = this.getModuleInfo(id);
                    if (!info)
                        return;
                    const dependencyModuleIds = [
                        ...info.importedIds,
                        ...info.dynamicallyImportedIds
                    ];
                    const isImportSharedLib = dependencyModuleIds.some((id) => sharedLibIds.has(id));
                    if (isImportSharedLib) {
                        moduleNeedToTransformSet.add(id);
                    }
                    dependencyModuleIds.forEach(addDeps);
                };
                exposedModuleIds.forEach(addDeps);
            }
            return outputOption;
        },
        renderChunk: function (code, chunk, options) {
            if (!isRemote)
                return null;
            // means that there's no module import shared libs
            if (moduleNeedToTransformSet.size === 0)
                return null;
            const relatedModules = Object.keys(chunk.modules);
            if (relatedModules.some((id) => moduleNeedToTransformSet.has(id))) {
                const transformedCode = transformImportFn.apply(this, [
                    code,
                    chunk,
                    options
                ]);
                if (transformedCode)
                    return transformedCode;
            }
            return null;
        }
    };
}

function prodExposePlugin(options) {
    let moduleMap = '';
    parsedOptions.prodExpose = parseExposeOptions(options);
    // exposes module
    for (const item of parsedOptions.prodExpose) {
        getModuleMarker(`\${${item[0]}}`, SHARED);
        const exposeFilepath = normalizePath(resolve(item[1].import));
        EXPOSES_MAP.set(item[0], exposeFilepath);
        EXPOSES_KEY_MAP.set(item[0], `__federation_expose_${removeNonRegLetter(item[0], NAME_CHAR_REG)}`);
        moduleMap += `\n"${item[0]}":()=>{
      ${DYNAMIC_LOADING_CSS}('${DYNAMIC_LOADING_CSS_PREFIX}${exposeFilepath}')
      return __federation_import('\${__federation_expose_${item[0]}}').then(module =>Object.keys(module).every(item => exportSet.has(item)) ? () => module.default : () => module)},`;
    }
    let remoteEntryChunk;
    let viteConfigResolved;
    return {
        name: 'originjs:expose-production',
        virtualFile: {
            // code generated for remote
            // language=JS
            __remoteEntryHelper__: `
      const exportSet = new Set(['Module', '__esModule', 'default', '_export_sfc']);
      let moduleMap = {${moduleMap}}
    const seen = {}
    export const ${DYNAMIC_LOADING_CSS} = (cssFilePaths) => {
      const metaUrl = import.meta.url
      if (typeof metaUrl == 'undefined') {
        console.warn('The remote style takes effect only when the build.target option in the vite.config.ts file is higher than that of "es2020".')
        return
      }
      const curUrl = metaUrl.substring(0, metaUrl.lastIndexOf('${options.filename}'))

      cssFilePaths.forEach(cssFilePath => {
        const href = curUrl + cssFilePath
        if (href in seen) return
        seen[href] = true
        const element = document.head.appendChild(document.createElement('link'))
        element.href = href
        element.rel = 'stylesheet'
      })
    };
    async function __federation_import(name) {
        return import(name);
    };
    export const get =(module) => {
        return moduleMap[module]();
    };
    export const init =(shareScope) => {
      globalThis.__federation_shared__= globalThis.__federation_shared__|| {};
      Object.entries(shareScope).forEach(([key, value]) => {
        const versionKey = Object.keys(value)[0];
        const versionValue = Object.values(value)[0];
        const scope = versionValue.scope || 'default'
        globalThis.__federation_shared__[scope] = globalThis.__federation_shared__[scope] || {};
        const shared= globalThis.__federation_shared__[scope];
        (shared[key] = shared[key]||{})[versionKey] = versionValue;
      });
    }`
        },
        options() {
            // Split expose & shared module to separate chunks
            // _options.preserveEntrySignatures = 'strict'
            return null;
        },
        configResolved(config) {
            viteConfigResolved = config;
        },
        buildStart() {
            // if we don't expose any modules, there is no need to emit file
            if (parsedOptions.prodExpose.length > 0) {
                this.emitFile({
                    fileName: `${builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''}${options.filename}`,
                    type: 'chunk',
                    id: '__remoteEntryHelper__',
                    preserveSignature: 'strict'
                });
            }
        },
        generateBundle(_options, bundle) {
            // replace import absolute path to chunk's fileName in remoteEntry.js
            if (!remoteEntryChunk) {
                for (const file in bundle) {
                    const chunk = bundle[file];
                    if ((chunk === null || chunk === void 0 ? void 0 : chunk.facadeModuleId) === '\0virtual:__remoteEntryHelper__') {
                        remoteEntryChunk = chunk;
                        break;
                    }
                }
            }
            // placeholder replace
            if (remoteEntryChunk) {
                const filepathMap = new Map();
                const getFilename = (name) => parse(parse(name).name).name;
                const cssBundlesMap = Object.keys(bundle)
                    .filter((name) => extname(name) === '.css')
                    .reduce((res, name) => {
                        const filename = getFilename(name);
                        res.set(filename, bundle[name]);
                        return res;
                    }, new Map());
                remoteEntryChunk.code = remoteEntryChunk.code.replace(new RegExp(`(["'])${DYNAMIC_LOADING_CSS_PREFIX}.*?\\1`, 'g'), (str) => {
                    // when build.cssCodeSplit: false, all files are aggregated into style.xxxxxxxx.css
                    if (viteConfigResolved && !viteConfigResolved.build.cssCodeSplit) {
                        if (cssBundlesMap.size) {
                            return `[${[...cssBundlesMap.values()]
                                .map((cssBundle) => JSON.stringify(basename(cssBundle.fileName)))
                                .join(',')}]`;
                        }
                        else {
                            return '[]';
                        }
                    }
                    const filepath = str.slice((`'` + DYNAMIC_LOADING_CSS_PREFIX).length, -1);
                    if (!filepath || !filepath.length)
                        return str;
                    let fileBundle = filepathMap.get(filepath);
                    if (!fileBundle) {
                        fileBundle = Object.values(bundle).find((b) => 'facadeModuleId' in b && b.facadeModuleId === filepath);
                        if (fileBundle)
                            filepathMap.set(filepath, fileBundle);
                        else
                            return str;
                    }
                    const depCssFiles = new Set();
                    const addDepCss = (bundleName) => {
                        const filename = getFilename(bundleName);
                        const cssBundle = cssBundlesMap.get(filename);
                        if (cssBundle) {
                            depCssFiles.add(cssBundle.fileName);
                        }
                        const theBundle = bundle[bundleName];
                        if (theBundle && theBundle.imports && theBundle.imports.length) {
                            theBundle.imports.forEach((name) => addDepCss(name));
                        }
                    };
                    [fileBundle.fileName, ...fileBundle.imports].forEach(addDepCss);
                    return `[${[...depCssFiles]
                        .map((d) => JSON.stringify(basename(d)))
                        .join(',')}]`;
                });
                // replace the export file placeholder path to final chunk path
                for (const expose of parsedOptions.prodExpose) {
                    const module = Object.keys(bundle).find((module) => {
                        const chunk = bundle[module];
                        return chunk.name === EXPOSES_KEY_MAP.get(expose[0]);
                    });
                    if (module) {
                        const chunk = bundle[module];
                        const fileRelativePath = relative(dirname(remoteEntryChunk.fileName), chunk.fileName);
                        const slashPath = fileRelativePath.replace(/\\/g, '/');
                        remoteEntryChunk.code = remoteEntryChunk.code.replace(`\${__federation_expose_${expose[0]}}`, `./${slashPath}`);
                    }
                }
                // remove all __f__dynamic_loading_css__ after replace
                let ast = null;
                try {
                    ast = this.parse(remoteEntryChunk.code);
                }
                catch (err) {
                    console.error(err);
                }
                if (!ast) {
                    return;
                }
                const magicString = new MagicString(remoteEntryChunk.code);
                // let cssFunctionName: string = DYNAMIC_LOADING_CSS
                walk(ast, {
                    enter(node) {
                        var _a, _b;
                        if (node &&
                            node.type === 'CallExpression' &&
                            typeof ((_a = node.arguments[0]) === null || _a === void 0 ? void 0 : _a.value) === 'string' &&
                            ((_b = node.arguments[0]) === null || _b === void 0 ? void 0 : _b.value.indexOf(`${DYNAMIC_LOADING_CSS_PREFIX}`)) > -1) {
                            magicString.remove(node.start, node.end + 1);
                        }
                    }
                });
                remoteEntryChunk.code = magicString.toString();
            }
        }
    };
}

function devSharedPlugin(options) {
    parsedOptions.devShared = parseSharedOptions(options);
    return {
        name: 'originjs:shared-development'
    };
}

function devRemotePlugin(options) {
    parsedOptions.devRemote = parseRemoteOptions(options);
    const remotes = [];
    for (const item of parsedOptions.devRemote) {
        remotes.push({
            id: item[0],
            regexp: new RegExp(`^${item[0]}/.+?`),
            config: item[1]
        });
    }
    let viteDevServer;
    let browserHash;
    return {
        name: 'originjs:remote-development',
        virtualFile: {
            __federation__: `
${createRemotesMap(remotes)}
const loadJS = async (url, fn) => {
  const resolvedUrl = typeof url === 'function' ? await url() : url;
  const script = document.createElement('script')
  script.type = 'text/javascript';
  script.onload = fn;
  script.src = resolvedUrl;
  document.getElementsByTagName('head')[0].appendChild(script);
}
const scriptTypes = ['var'];
const importTypes = ['esm', 'systemjs']
function get(name, ${REMOTE_FROM_PARAMETER}){
  return import(/* @vite-ignore */ name).then(module => ()=> {
    if (${REMOTE_FROM_PARAMETER} === 'webpack') {
      return Object.prototype.toString.call(module).indexOf('Module') > -1 && module.default ? module.default : module
    }
    return module
  })
}
const wrapShareScope = ${REMOTE_FROM_PARAMETER} => {
  return {
    ${getModuleMarker('shareScope')}
  }
}
const initMap = Object.create(null);
async function __federation_method_ensure(remoteId) {
  const remote = remotesMap[remoteId];
  if (!remote.inited) {
    if (scriptTypes.includes(remote.format)) {
      // loading js with script tag
      return new Promise(resolve => {
        const callback = () => {
          if (!remote.inited) {
            remote.lib = window[remoteId];
            remote.lib.init(wrapShareScope(remote.from))
            remote.inited = true;
          }
          resolve(remote.lib);
        }
        return loadJS(remote.url, callback);
      });
    } else if (importTypes.includes(remote.format)) {
      // loading js with import(...)
      return new Promise(resolve => {
        const getUrl = typeof remote.url === 'function' ? remote.url : () => Promise.resolve(remote.url);
        getUrl().then(url => {
          import(/* @vite-ignore */ url).then(lib => {
            if (!remote.inited) {
              const shareScope = wrapShareScope(remote.from)
              lib.init(shareScope);
              remote.lib = lib;
              remote.lib.init(shareScope);
              remote.inited = true;
            }
            resolve(remote.lib);
          })
        })
      })
    }
  } else {
    return remote.lib;
  }
}

function __federation_method_unwrapDefault(module) {
  return (module?.__esModule || module?.[Symbol.toStringTag] === 'Module')?module.default:module
}

function __federation_method_wrapDefault(module ,need){
  if (!module?.default && need) {
    let obj = Object.create(null);
    obj.default = module;
    obj.__esModule = true;
    return obj;
  }
  return module; 
}

function __federation_method_getRemote(remoteName,  componentName){
  return __federation_method_ensure(remoteName).then((remote) => remote.get(componentName).then(factory => factory()));
}
export {__federation_method_ensure, __federation_method_getRemote , __federation_method_unwrapDefault , __federation_method_wrapDefault}
;`
        },
        config(config) {
            // need to include remotes in the optimizeDeps.exclude
            if (parsedOptions.devRemote.length) {
                const excludeRemotes = [];
                parsedOptions.devRemote.forEach((item) => excludeRemotes.push(item[0]));
                let optimizeDeps = config.optimizeDeps;
                if (!optimizeDeps) {
                    optimizeDeps = config.optimizeDeps = {};
                }
                if (!optimizeDeps.exclude) {
                    optimizeDeps.exclude = [];
                }
                optimizeDeps.exclude = optimizeDeps.exclude.concat(excludeRemotes);
            }
        },
        configureServer(server) {
            // get moduleGraph for dev mode dynamic reference
            viteDevServer = server;
        },
        async transform(code, id) {
            var _a, _b, _c;
            if (builderInfo.isHost && !builderInfo.isRemote) {
                if (!browserHash || browserHash.length === 0) {
                    browserHash = (_a = viteDevServer._optimizeDepsMetadata) === null || _a === void 0 ? void 0 : _a.browserHash;
                    const optimized = (_b = viteDevServer._optimizeDepsMetadata) === null || _b === void 0 ? void 0 : _b.optimized;
                    if (optimized !== undefined) {
                        for (const arr of parsedOptions.devShared) {
                            if (!arr[1].version && !arr[1].manuallyPackagePathSetting) {
                                const regExp = new RegExp(`node_modules[/\\\\]${arr[0]}[/\\\\]`);
                                const packageJsonPath = `${(_c = optimized[arr[0]].src) === null || _c === void 0 ? void 0 : _c.split(regExp)[0]}node_modules/${arr[0]}/package.json`;
                                try {
                                    arr[1].version = (await import(packageJsonPath)).version;
                                    arr[1].version.length;
                                }
                                catch (e) {
                                    this.error(`No description file or no version in description file (usually package.json) of ${arr[0]}(${packageJsonPath}). Add version to description file, or manually specify version in shared config.`);
                                }
                            }
                        }
                    }
                }
                if (id === '\0virtual:__federation__') {
                    const scopeCode = await devSharedScopeCode.call(this, parsedOptions.devShared, browserHash);
                    return code.replace(getModuleMarker('shareScope'), scopeCode.join(','));
                }
                let ast = null;
                try {
                    ast = this.parse(code);
                }
                catch (err) {
                    console.error(err);
                }
                if (!ast) {
                    return null;
                }
                const magicString = new MagicString(code);
                const hasStaticImported = new Map();
                let requiresRuntime = false;
                walk(ast, {
                    enter(node) {
                        var _a, _b, _c;
                        if ((node.type === 'ImportExpression' ||
                            node.type === 'ImportDeclaration' ||
                            node.type === 'ExportNamedDeclaration') &&
                            ((_b = (_a = node.source) === null || _a === void 0 ? void 0 : _a.value) === null || _b === void 0 ? void 0 : _b.indexOf('/')) > -1) {
                            const moduleId = node.source.value;
                            const remote = remotes.find((r) => r.regexp.test(moduleId));
                            const needWrap = (remote === null || remote === void 0 ? void 0 : remote.config.from) === 'vite';
                            if (remote) {
                                requiresRuntime = true;
                                const modName = `.${moduleId.slice(remote.id.length)}`;
                                switch (node.type) {
                                    case 'ImportExpression': {
                                        magicString.overwrite(node.start, node.end, `__federation_method_getRemote(${JSON.stringify(remote.id)} , ${JSON.stringify(modName)}).then(module=>__federation_method_wrapDefault(module, ${needWrap}))`);
                                        break;
                                    }
                                    case 'ImportDeclaration': {
                                        if ((_c = node.specifiers) === null || _c === void 0 ? void 0 : _c.length) {
                                            const afterImportName = `__federation_var_${moduleId.replace(/[@/\\.-]/g, '')}`;
                                            if (!hasStaticImported.has(moduleId)) {
                                                magicString.overwrite(node.start, node.end, `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(remote.id)} , ${JSON.stringify(modName)});`);
                                                hasStaticImported.set(moduleId, afterImportName);
                                            }
                                            let deconstructStr = '';
                                            node.specifiers.forEach((spec) => {
                                                // default import , like import a from 'lib'
                                                if (spec.type === 'ImportDefaultSpecifier') {
                                                    magicString.appendRight(node.end, `\n let ${spec.local.name} = __federation_method_unwrapDefault(${afterImportName}) `);
                                                }
                                                else if (spec.type === 'ImportSpecifier') {
                                                    //  like import {a as b} from 'lib'
                                                    const importedName = spec.imported.name;
                                                    const localName = spec.local.name;
                                                    deconstructStr += `${importedName === localName
                                                        ? localName
                                                        : `${importedName} : ${localName}`},`;
                                                }
                                                else if (spec.type === 'ImportNamespaceSpecifier') {
                                                    //  like import * as a from 'lib'
                                                    magicString.appendRight(node.end, `let {${spec.local.name}} = ${afterImportName}`);
                                                }
                                            });
                                            if (deconstructStr.length > 0) {
                                                magicString.appendRight(node.end, `\n let {${deconstructStr.slice(0, -1)}} = ${afterImportName}`);
                                            }
                                        }
                                        break;
                                    }
                                    case 'ExportNamedDeclaration': {
                                        // handle export like export {a} from 'remotes/lib'
                                        const afterImportName = `__federation_var_${moduleId.replace(/[@/\\.-]/g, '')}`;
                                        if (!hasStaticImported.has(moduleId)) {
                                            hasStaticImported.set(moduleId, afterImportName);
                                            magicString.overwrite(node.start, node.end, `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(remote.id)} , ${JSON.stringify(modName)});`);
                                        }
                                        if (node.specifiers.length > 0) {
                                            const specifiers = node.specifiers;
                                            let exportContent = '';
                                            let deconstructContent = '';
                                            specifiers.forEach((spec) => {
                                                const localName = spec.local.name;
                                                const exportName = spec.exported.name;
                                                const variableName = `${afterImportName}_${localName}`;
                                                deconstructContent = deconstructContent.concat(`${localName}:${variableName},`);
                                                exportContent = exportContent.concat(`${variableName} as ${exportName},`);
                                            });
                                            magicString.append(`\n const {${deconstructContent.slice(0, deconstructContent.length - 1)}} = ${afterImportName}; \n`);
                                            magicString.append(`\n export {${exportContent.slice(0, exportContent.length - 1)}}; `);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                });
                if (requiresRuntime) {
                    magicString.prepend(`import {__federation_method_ensure, __federation_method_getRemote , __federation_method_wrapDefault , __federation_method_unwrapDefault} from '__federation__';\n\n`);
                }
                return magicString.toString();
            }
        }
    };
    async function devSharedScopeCode(shared, viteVersion) {
        var _a;
        const hostname = resolveHostname(viteDevServer.config.server.host);
        const protocol = viteDevServer.config.server.https ? 'https' : 'http';
        const port = (_a = viteDevServer.config.server.port) !== null && _a !== void 0 ? _a : 5000;
        const regExp = new RegExp(`${normalizePath(viteDevServer.config.root)}[/\\\\]`);
        let cacheDir = viteDevServer.config.cacheDir;
        cacheDir = `${cacheDir === null || cacheDir === void 0
            ? 'node_modules/.vite'
            : normalizePath(cacheDir).split(regExp)[1]}`;
        const res = [];
        if (shared.length) {
            const cwdPath = normalizePath(process.cwd());
            for (const item of shared) {
                const moduleInfo = await this.resolve(item[1].packagePath, undefined, {
                    skipSelf: true
                });
                if (!moduleInfo)
                    continue;
                const moduleFilePath = normalizePath(moduleInfo.id);
                const idx = moduleFilePath.indexOf(cwdPath);
                const relativePath = idx === 0 ? moduleFilePath.slice(cwdPath.length) : null;
                const sharedName = item[0];
                const obj = item[1];
                let str = '';
                if (typeof obj === 'object') {
                    const url = relativePath
                        ? `'${protocol}://${hostname.name}:${port}${relativePath}'`
                        : `'${protocol}://${hostname.name}:${port}/${cacheDir}/${sharedName}.js?v=${viteVersion}'`;
                    str += `get:()=> get(${url}, ${REMOTE_FROM_PARAMETER})`;
                    res.push(`'${sharedName}':{'${obj.version}':{${str}}}`);
                }
            }
        }
        return res;
    }
    function resolveHostname(optionsHost) {
        let host;
        if (optionsHost === undefined ||
            optionsHost === false ||
            optionsHost === 'localhost') {
            // Use a secure default
            host = '127.0.0.1';
        }
        else if (optionsHost === true) {
            // If passed --host in the CLI without arguments
            host = undefined; // undefined typically means 0.0.0.0 or :: (listen on all IPs)
        }
        else {
            host = optionsHost;
        }
        // Set host name to localhost when possible, unless the user explicitly asked for '127.0.0.1'
        const name = (optionsHost !== '127.0.0.1' && host === '127.0.0.1') ||
            host === '0.0.0.0' ||
            host === '::' ||
            host === undefined
            ? 'localhost'
            : host;
        return { host, name };
    }
}

function devExposePlugin(options) {
    parsedOptions.devExpose = parseExposeOptions(options);
    return {
        name: 'originjs:expose-development'
    };
}

function federation(options) {
    options.filename = options.filename
        ? options.filename
        : DEFAULT_ENTRY_FILENAME;
    let pluginList = [];
    let virtualMod;
    let registerCount = 0;
    function registerPlugins(mode, command) {
        if (mode === 'development' || command === 'serve') {
            pluginList = [
                devSharedPlugin(options),
                devExposePlugin(options),
                devRemotePlugin(options)
            ];
        }
        else if (mode === 'production' || command === 'build') {
            pluginList = [
                prodSharedPlugin(options),
                prodExposePlugin(options),
                prodRemotePlugin(options)
            ];
        }
        else {
            pluginList = [];
        }
        builderInfo.isHost = !!(parsedOptions.prodRemote.length || parsedOptions.devRemote.length);
        builderInfo.isRemote = !!(parsedOptions.prodExpose.length || parsedOptions.devExpose.length);
        builderInfo.isShared = !!(parsedOptions.prodShared.length || parsedOptions.devShared.length);
        let virtualFiles = {};
        pluginList.forEach((plugin) => {
            if (plugin.virtualFile) {
                virtualFiles = Object.assign(virtualFiles, plugin.virtualFile);
            }
        });
        virtualMod = virtual(virtualFiles);
    }
    return {
        name: 'originjs:federation',
        // for scenario vite.config.js build.cssCodeSplit: false
        // vite:css-post plugin will summarize all the styles in the style.xxxxxx.css file
        // so, this plugin need run after vite:css-post in post plugin list
        enforce: 'post',
        // apply:'build',
        options(_options) {
            var _a, _b;
            // rollup doesnt has options.mode and options.command
            if (!registerCount++) {
                registerPlugins((options.mode = (_a = options.mode) !== null && _a !== void 0 ? _a : 'production'), '');
            }
            if (typeof _options.input === 'string') {
                _options.input = { index: _options.input };
            }
            _options.external = _options.external || [];
            if (!Array.isArray(_options.external)) {
                _options.external = [_options.external];
            }
            for (const pluginHook of pluginList) {
                (_b = pluginHook.options) === null || _b === void 0 ? void 0 : _b.call(this, _options);
            }
            return _options;
        },
        config(config, env) {
            var _a, _b, _c;
            options.mode = env.mode;
            registerPlugins(options.mode, env.command);
            registerCount++;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.config) === null || _a === void 0 ? void 0 : _a.call(this, config, env);
            }
            // only run when builder is vite,rollup doesnt has hook named `config`
            builderInfo.builder = 'vite';
            builderInfo.assetsDir = (_c = (_b = config === null || config === void 0 ? void 0 : config.build) === null || _b === void 0 ? void 0 : _b.assetsDir) !== null && _c !== void 0 ? _c : 'assets';
        },
        configureServer(server) {
            var _a;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.configureServer) === null || _a === void 0 ? void 0 : _a.call(this, server);
            }
        },
        configResolved(config) {
            var _a;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.configResolved) === null || _a === void 0 ? void 0 : _a.call(this, config);
            }
        },
        buildStart(inputOptions) {
            var _a;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.buildStart) === null || _a === void 0 ? void 0 : _a.call(this, inputOptions);
            }
        },
        resolveId(...args) {
            const v = virtualMod.resolveId.call(this, ...args);
            if (v) {
                return v;
            }
            return null;
        },
        load(...args) {
            const v = virtualMod.load.call(this, ...args);
            if (v) {
                return v;
            }
            return null;
        },
        transform(code, id) {
            var _a;
            for (const pluginHook of pluginList) {
                const result = (_a = pluginHook.transform) === null || _a === void 0 ? void 0 : _a.call(this, code, id);
                if (result) {
                    return result;
                }
            }
            return code;
        },
        moduleParsed(moduleInfo) {
            var _a;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.moduleParsed) === null || _a === void 0 ? void 0 : _a.call(this, moduleInfo);
            }
        },
        outputOptions(outputOptions) {
            var _a;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.outputOptions) === null || _a === void 0 ? void 0 : _a.call(this, outputOptions);
            }
            return outputOptions;
        },
        renderChunk(code, chunkInfo, _options) {
            var _a;
            for (const pluginHook of pluginList) {
                const result = (_a = pluginHook.renderChunk) === null || _a === void 0 ? void 0 : _a.call(this, code, chunkInfo, _options);
                if (result) {
                    return result;
                }
            }
            return null;
        },
        generateBundle: function (_options, bundle, isWrite) {
            var _a;
            for (const pluginHook of pluginList) {
                (_a = pluginHook.generateBundle) === null || _a === void 0 ? void 0 : _a.call(this, _options, bundle, isWrite);
            }
        }
    };
}

export { federation as default };
