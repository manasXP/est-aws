import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import Ajv from 'ajv';
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

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const dereferenced = new Map<Surface, Promise<OpenAPIV3_1.Document>>();

// Validates and fully dereferences a document. Throws if it is not valid OpenAPI.
function loadContractDoc(surface: Surface): Promise<OpenAPIV3_1.Document> {
  let promise = dereferenced.get(surface);
  if (!promise) {
    promise = SwaggerParser.validate(DOC_PATH[surface]) as Promise<OpenAPIV3_1.Document>;
    dereferenced.set(surface, promise);
  }
  return promise;
}

export interface ContractOperation {
  expectValidResponse(status: number, body: unknown): void;
}

// Looks up the operation for `verb path` in the given surface's OpenAPI document.
// Throws if the path/verb is not declared — an undeclared route is a contract
// violation, never a silent pass (STR-002 AC3).
export async function contractTest(surface: Surface, path: string, verb: Verb): Promise<ContractOperation> {
  const doc = await loadContractDoc(surface);
  const operation = (doc.paths?.[path] as Record<string, OpenAPIV3_1.OperationObject> | undefined)?.[verb];
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

      const validate = ajv.compile(schema);
      if (!validate(body)) {
        throw new Error(
          `Contract violation: ${verb.toUpperCase()} ${path} ${status} response does not match its schema:\n${ajv.errorsText(validate.errors)}`
        );
      }
    }
  };
}
