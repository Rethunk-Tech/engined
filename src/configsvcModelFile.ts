/** One weights file the config UI lists under an engine's `models_dir`. */
export interface ModelFile {
  path: string
  bytes: number
  gguf?: {
    architecture?: string
    context_length?: number
    block_count?: number
    head_count?: number
    head_count_kv?: number
    embedding_length?: number
    key_length?: number
    full_attention_interval?: number
    nextn_predict_layers?: number
    value_length?: number
    quantization?: string
    has_chat_template: boolean
  }
}
