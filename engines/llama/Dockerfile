# llama.cpp server, Vulkan/RADV, gfx1151 (Strix Halo).
#
# What this tree owns is the recipe and llama-grammar.patch. The source is
# PrismML-Eng/llama.cpp (a fork of upstream llama.cpp, MIT) at the exact
# commit LLAMA_COMMIT names below -- the built image labels that commit, so a
# throughput measurement can be tied back to the source it was taken on.
#
# The fork rather than mainline because Prism's ternary types are private to
# it: a stock build refuses a Bonsai file outright ("tensor 'output.weight'
# has invalid ggml type 142"), and the Hadamard activation transform those
# weights are stored against is not upstream. The fork also carries both
# speculative types the routes here name -- `draft-mtp`, head baked into the
# GGUF, and `draft-dflash`, a separate drafter named by `spec-draft-model`.
# Of the two ternary packings only PTQ1_0 has Vulkan pipelines; PQ2_0 is
# CUDA/Metal/CPU/ROCm only, so a PQ2_0 file cannot run on this image.
#
# Fedora, not rocm/dev-ubuntu like the sibling engines: the ROCm half of this
# build needs hipblas and the runtime, not a PyTorch stack, and Fedora ships
# both. See spec.toml -- carrying a ROCm backend is why this engine takes
# /dev/kfd as well as /dev/dri.

# Global, so the final stage can label the same values without repeating them.
ARG REPO=https://github.com/PrismML-Eng/llama.cpp.git
# The head of the fork's `prism` branch as of this pin. A branch name here
# would let two builds of the same tree produce different llama.cpp with
# nothing recording which one a measurement was taken on.
ARG LLAMA_COMMIT=9a9394a895b96003ca842a6041cb28ac49a108f7

FROM registry.fedoraproject.org/fedora:46 AS builder

RUN dnf -y --nodocs --setopt=install_weak_deps=False install \
  git \
  make gcc gcc-c++ cmake ninja-build lld clang clang-devel compiler-rt libcurl-devel rdma-core-devel \
  vulkan-loader-devel vulkaninfo mesa-vulkan-drivers \
  spirv-headers-devel glslc patch \
  rocm-hip-devel rocblas-devel hipblas-devel rocm-comgr-devel \
  && dnf clean all && rm -rf /var/cache/dnf/*

WORKDIR /opt/llama.cpp
ARG REPO
ARG LLAMA_COMMIT
RUN git clone "${REPO}" . \
    && git checkout --detach "${LLAMA_COMMIT}" \
    && git submodule update --init --recursive

# MAX_REPETITION_THRESHOLD 2000 -> 100000: too low for complex tool-call
# grammars (json-schema-derived GBNF can legitimately need more repetitions).
COPY llama-grammar.patch /tmp/llama-grammar.patch
RUN patch -p1 < /tmp/llama-grammar.patch

# An MTP head reads token embeddings in the trunk's own basis, and this fork
# applies no inverse transform when that table is a Hadamard latent -- so a
# Bonsai file whose head is baked in refuses to build its draft context
# ("Hadamard-latent table 'token_embd.weight' is read without the inverse
# transform") and the server exits 1 at load. From ProCreations, who ship the
# MTP head this engine's bonsai route runs.
COPY bonsai-mtp-embedding.patch /tmp/bonsai-mtp-embedding.patch
RUN patch -p1 < /tmp/bonsai-mtp-embedding.patch

# EXAMPLES=OFF here breaks the build (LLAMA_BUILD_SERVER depends on it in
# this fork's CMakeLists) -- confirmed by hitting exactly that failure.
#
# Both backends in one binary, and a route pins which one it wants with
# `device`. Neither covers this box alone: Vulkan decodes ornith fastest
# (69.1 t/s against ROCm's 54.1 on the same prompt) while carrying no PQ2_0
# kernels at all, and ROCm is the only backend where a ternary Bonsai file is
# worth running (35.6 t/s PQ2_0 against 4.0 t/s for the Vulkan-capable PTQ1_0
# packing). A route that names no device gets whichever ggml ranks first,
# which is how ornith would silently lose 15 t/s.
RUN cmake -S . -B build -G Ninja \
    -DGGML_VULKAN=ON \
    -DGGML_HIP=ON \
    -DAMDGPU_TARGETS=gfx1151 \
    -DCMAKE_HIP_ARCHITECTURES=gfx1151 \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_RPC=ON \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=ON \
    -DLLAMA_BUILD_SERVER=ON \
    && cmake --build build --config Release \
    && cmake --install build --config Release

RUN find /opt/llama.cpp/build -type f -name 'lib*.so*' -exec cp {} /usr/lib64/ \; && ldconfig

FROM registry.fedoraproject.org/fedora-minimal:46
ARG REPO
ARG LLAMA_COMMIT
LABEL org.opencontainers.image.source="${REPO}" \
      org.opencontainers.image.revision="${LLAMA_COMMIT}"

RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install \
  bash ca-certificates libatomic libstdc++ libgcc libgomp libibverbs \
  vulkan-loader mesa-vulkan-drivers \
  rocm-runtime rocblas hipblas \
  && microdnf clean all && rm -rf /var/cache/dnf/*

COPY --from=builder /usr/bin/llama-server /usr/bin/llama-server
COPY --from=builder /usr/lib64/libllama.so* /usr/lib64/libllama-common.so* /usr/lib64/libllama-server-impl.so \
  /usr/lib64/libggml*.so* /usr/lib64/libmtmd*.so* /usr/lib64/
RUN ldconfig

EXPOSE 8080
ENTRYPOINT ["/usr/bin/llama-server"]
