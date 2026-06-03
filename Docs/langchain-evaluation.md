# LangChain Evaluation for Specialization Explorer

## Context
We already have a working text generation pipeline (streaming, history management, prompt caching, guardrails) built directly on Bedrock. The remaining migration work is swapping Bedrock Knowledge Base retrieval for pgvector with Entra group-based access filtering.

## Pros & Cons

| Factor | Without LangChain (current approach) | With LangChain |
|--------|--------------------------------------|----------------|
| **History management** | Already implemented — last 20 messages fetched from Postgres `chat_messages`, passed directly to Bedrock `converse_stream` | `ConversationBufferMemory` does the same thing under the hood; no net gain |
| **API cost** | No change — tokens sent to Bedrock are identical regardless of library | No savings — LangChain assembles the same messages array we already build |
| **Streaming** | Custom `<answer>`/`<cited_indices>` tag parsing works cleanly today | LangChain output parsers would conflict with our streaming tag logic |
| **Retrieval** | pgvector SQL with Entra group filter is already written (from notebook) | LangChain pgvector retriever doesn't support our custom `group_ids ?| array` filter natively — would need overriding |
| **Lambda cold starts** | ~50MB smaller deployment package | Adds ~50MB+ of dependencies, requiring provisioned concurrency to stay acceptable |
| **Storage** | Chat history already in Postgres (single source of truth) | Memory persistence would push toward DynamoDB — two storage layers for no gain |
| **Prompt caching** | Already implemented on static system prompt via Bedrock cache points | LangChain's Bedrock integration doesn't expose cache point control |
| **Maintenance** | We own every line — no upstream breaking changes | LangChain has a history of breaking API changes between minor versions |
| **Conversation length** | Sessions are short (students ask a few questions per session) — buffer memory with LIMIT 20 is more than sufficient | Summary/token memory only pays off for very long conversations — not our use case |
| **Complexity** | Direct Bedrock SDK calls are straightforward to debug and extend | Adds an abstraction layer over Bedrock that obscures what's actually being sent |

## Verdict
LangChain does not provide a meaningful benefit for this project. Every capability it offers is either already implemented or inapplicable to our use case. The costs (cold starts, storage overhead, streaming conflicts, lost cache control) outweigh any convenience gains.
