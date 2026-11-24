import { describe, expect, test } from 'bun:test'
import { fetchComfyCatalog } from './comfyCatalog.ts'

/** A real HTTP stand-in for ComfyUI's `GET /object_info/{node}`: answers `{}` for a class it was not given, as ComfyUI does. */
function objectInfoStub(nodes: Record<string, unknown>) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const node = new URL(req.url).pathname.split('/').pop() ?? ''
      return Response.json(node in nodes ? { [node]: nodes[node] } : {})
    },
  })
}

const loader = (input: string, spec: unknown) => ({ input: { required: { [input]: spec } } })

describe('fetchComfyCatalog', () => {
  test('reads output modalities and splits loader names into image and video', async () => {
    const stub = objectInfoStub({
      SaveImage: {},
      SaveVideo: {},
      CheckpointLoaderSimple: loader('ckpt_name', [
        ['sdxl.safetensors', 'ltx-video-2b.safetensors'],
      ]),
      UNETLoader: loader('unet_name', [['Chroma1-HD.safetensors', 'wan2.1_t2v_14B.safetensors']]),
    })
    try {
      expect(await fetchComfyCatalog(`http://127.0.0.1:${stub.port}`)).toEqual({
        output: ['image', 'video'],
        checkpoints: {
          image: ['Chroma1-HD.safetensors', 'sdxl.safetensors'],
          video: ['ltx-video-2b.safetensors', 'wan2.1_t2v_14B.safetensors'],
        },
      })
    } finally {
      stub.stop()
    }
  })

  test('reads a combo list sent in the newer COMBO shape, and reports image only without a video saver', async () => {
    const stub = objectInfoStub({
      SaveImage: {},
      CheckpointLoaderSimple: loader('ckpt_name', ['COMBO', { options: ['a.safetensors'] }]),
    })
    try {
      expect(await fetchComfyCatalog(`http://127.0.0.1:${stub.port}`)).toEqual({
        output: ['image'],
        checkpoints: { image: ['a.safetensors'], video: [] },
      })
    } finally {
      stub.stop()
    }
  })

  test('rejects, rather than claiming an empty catalog, when comfy knows none of the output nodes', async () => {
    const stub = objectInfoStub({})
    try {
      await expect(fetchComfyCatalog(`http://127.0.0.1:${stub.port}`)).rejects.toThrow(
        'no output nodes',
      )
    } finally {
      stub.stop()
    }
  })
})
