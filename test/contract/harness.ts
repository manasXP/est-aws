import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Surface = 'admin' | 'mobile';
export type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

// The two OpenAPI documents are read directly from the est-spec submodule —
// no vendored copy, so there is nothing that can drift out of sync.
const DOC_PATH: Record<Surface, string> = {
  admin: join(__dirname, '../../est-spec/okf-bundle/api/admin/openapi.yaml'),
  mobile: join(__dirname, '../../est-spec/okf-bundle/api/mobile/openapi.yaml')
};

// Validates and fully dereferences a document (path or in-memory object).
// Throws if it is not valid OpenAPI — exported so a test can exercise this
// exact function against a deliberately corrupted document.
export function validateDocument(pathOrDoc: string | object): Promise<OpenAPIV3_1.Document> {
  return SwaggerParser.validate(pathOrDoc as never) as Promise<OpenAPIV3_1.Document>;
}

// Both real documents are validated unconditionally as soon as this module is
// imported — by any test file, regardless of which surface it goes on to
// exercise. A corrupted document fails module load, not just a test that
// happens to touch it (AC1: "on every test run").
export const documents: Record<Surface, OpenAPIV3_1.Document> = {
  admin: await validateDocument(DOC_PATH.admin),
  mobile: await validateDocument(DOC_PATH.mobile)
};

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const compiledValidators = new WeakMap<object, ValidateFunction>();

function getValidator(schema: object): ValidateFunction {
  let validate = compiledValidators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiledValidators.set(schema, validate);
  }
  return validate;
}

// Matches a concrete request path (e.g. /members/m-123) against a document's
// declared paths, including OpenAPI path templates (/members/{memberId}).
function findOperation(
  doc: OpenAPIV3_1.Document,
  path: string,
  verb: Verb
): OpenAPIV3_1.OperationObject | undefined {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, OpenAPIV3_1.OperationObject>>;
  const exact = paths[path]?.[verb];
  if (exact) return exact;

  const requestSegments = path.split('/');
  for (const [template, item] of Object.entries(paths)) {
    const operation = item[verb];
    if (!operation) continue;
    const templateSegments = template.split('/');
    if (templateSegments.length !== requestSegments.length) continue;
    const matches = templateSegments.every(
      (segment, i) => (segment.startsWith('{') && segment.endsWith('}')) || segment === requestSegments[i]
    );
    if (matches) return operation;
  }
  return undefined;
}

export interface ContractOperation {
  expectValidResponse(status: number, body: unknown): void;
}

// Looks up the operation for `verb path` in the given surface's OpenAPI document.
// Throws if the path/verb is not declared — an undeclared route is a contract
// violation, never a silent pass (STR-002 AC3).
export async function contractTest(surface: Surface, path: string, verb: Verb): Promise<ContractOperation> {
  const doc = documents[surface];
  const operation = findOperation(doc, path, verb);
  if (!operation) {
    throw new Error(`Contract violation: ${verb.toUpperCase()} ${path} is not declared in the ${surface} OpenAPI document`);
  }

  return {
    expectValidResponse(status: number, body: unknown) {
      const response = operation.responses?.[String(status)] as OpenAPIV3_1.ResponseObject | undefined;
      if (!response) {
        throw new Error(`Contract violation: ${verb.toUpperCase()} ${path} has no ${status} response declared`);
      }
      const schema = response.content?.['application/json']?.schema;
      if (!schema) return; // no response body declared — nothing to validate

      const validate = getValidator(schema);
      if (!validate(body)) {
        throw new Error(
          `Contract violation: ${verb.toUpperCase()} ${path} ${status} response does not match its schema:\n${ajv.errorsText(validate.errors)}`
        );
      }
    }
  };
}
