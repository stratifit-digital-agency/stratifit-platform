# Glossary

> **Bootstrap draft derived from operator architecture brief — pending human review**

| Term | Definition |
|---|---|
| **Stratifit Control** | Internal Control Room / production operating system used only by authorized Stratifit operators. |
| **Stratifit Media** | Public, audience-first entertainment and social platform. |
| **Operator** | An authorized internal user of Stratifit Control. |
| **Audience user** | A public user of Stratifit Media; a viewer, not a producer. |
| **AI Creator** | A persistent, AI/virtual entertainer entity (Digital Human → Character → Persona → Creator → Public Profile → Content → Audience) whose identity, content, and behavior are controlled by the Control Room. |
| **Digital Human** | The underlying AI person representation beneath a Character. |
| **Persona** | The identity/personality layer above a Character, below Creator. |
| **Production** | A planned, gated unit of media work moving through the production pipeline. |
| **Production Gate** | The validation + approval checkpoint before compute allocation. |
| **Production manifest** | The approved, executable contract handed from planning to execution. |
| **Generation** | A single AI model execution producing an output; carries full provenance. |
| **Provenance** | The complete reproducibility record of a generation (model, workflow, prompts, seed, parameters, runtime, costs). |
| **Asset** | A managed media item (master or derivative) stored in object storage, referenced in PostgreSQL. |
| **Model registry** | Catalog of available AI models, versions, and capability contracts. |
| **Model adapter** | The layer translating a capability contract into a specific model's API/runtime. |
| **Model router** | Selects a model adapter for a capability according to approved policy. |
| **Workflow** | A versioned, registered executable definition (e.g., ComfyUI graph) behind a runtime abstraction. |
| **Workflow runtime** | The engine executing workflow definitions (ComfyUI initially, others possible). |
| **Compute provider** | An abstraction over GPU infrastructure (RunPod initially; others later). |
| **Compute manager** | Plans, allocates, and records compute usage across providers. |
| **Publishing engine** | Separate domain that takes approved content and distributes it via platform adapters. |
| **Publication record** | The transactional record of content approved for publication on a target. |
| **Platform adapter** | Target-specific publishing integration (Stratifit Media, YouTube, etc.). |
| **Lead** | A classified business inquiry originating from an AI-profile conversation in Control. |
| **Conversation** | A viewer ↔ AI profile message thread, distinguishable as AI/human/system messages. |
| **Domain event** | An idempotent, typed notification of a state transition (e.g., `job.completed`). |
| **Capability contract** | A schema-validated interface describing what an AI model can do. |
