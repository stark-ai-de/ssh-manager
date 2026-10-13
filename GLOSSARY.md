# SSH Manager domain language

## Distribution

**Runtime artifact**:
A distributable snapshot of the SSH Manager runtime, viewer, notices and license, whose manifest binds its payload to an exact producer revision. Consumer acceptance requires complete integrity verification against a separately trusted manifest digest; successful production alone does not establish publisher identity.

## Management transport

**Operation result**:
The successful data returned by one authenticated management operation. Runtime wire schemas own its accepted shape and decoded client type; canonical handler results must be assignable to the schema input but may be narrower. Existing wire meanings remain accepted, including absent or nullable job exit codes. HTTP, typed clients and MCP share this contract; client validation neither retries an operation nor proves remote completion.

## Verification

**Managed SSH fixture**:
An isolated synthetic SSH counterpart and approved manager owned by one test lifetime. Native OpenSSH qualification supplies distinct evidence and remains separately owned.
