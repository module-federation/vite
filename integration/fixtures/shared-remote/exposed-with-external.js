import { init } from 'mock-shared-dep';
import { externalHelper } from 'mock-external-dep';
// A second importer of the same external: by the time this module is parsed the
// external is already registered in the graph, so `getModuleInfo` returns a
// stub for it instead of null.
import { consumed } from './external-consumer.js';

export const readyWithExternal = `${init}:${externalHelper}:${consumed}`;
