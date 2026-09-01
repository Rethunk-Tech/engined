# llama.cpp server, Vulkan/RADV, gfx1151 (Strix Halo). Ported verbatim from
# sagaforge-ts's docker/llama-cpp/Dockerfile (read from source, not a
# summary), so that the image this box runs is built from this tree rather
# than a sibling project's. llama-grammar.patch is vendored alongside it
# unchanged.
#
# Builds from Nathanw1014/llama.cpp's `strix-halo-vulkan` branch (a fork of
# upstream llama.cpp, MIT), which carries Strix-Halo-specific Vulkan
# performance work not yet upstream. Recipe (source repo, branch, build
# flags, grammar patch) verified against
# kyuz0/amd-strix-halo-toolboxes:vulkan-radv-performance, which benchmarked
# best-of-both-worlds on this box: ROCm-tier prefill (~1050-1090 tok/s on an
# 8006-token prompt) with Vulkan-tier decode (~49 tok/s). Vendored and owned
# here (kyuz0's repo carries no LICENSE file) rather than depending on their
# prebuilt image indefinitely.
#
# Fedora, not rocm/dev-ubuntu like the sibling engines -- this is a Vulkan
# build (mesa-vulkan-drivers + the loader), not a ROCm/PyTorch one, so it
# doesn't need and doesn't take the ROCm base. See spec.toml: this engine
# takes only /dev/dri and deliberately not /dev/kfd, which is the same split
# reflected in the base image choice here.
FROM registry.fedoraproject.org/fedora:46 AS builder

RUN dnf -y --nodocs --setopt=install_weak_deps=False install \
  git \
  make gcc cmake ninja-build lld clang clang-devel compiler-rt libcurl-devel rdma-core-devel \
  vulkan-loader-devel vulkaninfo mesa-vulkan-drivers \
  spirv-headers-devel glslc patch \
  && dnf clean all && rm -rf /var/cache/dnf/*

WORKDIR /opt/llama.cpp
ARG REPO=https://github.com/Nathanw1014/llama.cpp.git
ARG BRANCH=strix-halo-vulkan
RUN git clone -b "${BRANCH}" --single-branch --recursive "${REPO}" .

# MAX_REPETITION_THRESHOLD 2000 -> 100000: too low for complex tool-call
# grammars (json-schema-derived GBNF can legitimately need more repetitions).
COPY llama-grammar.patch /tmp/llama-grammar.patch
RUN patch -p1 < /tmp/llama-grammar.patch

# EXAMPLES=OFF here breaks the build (LLAMA_BUILD_SERVER depends on it in
# this fork's CMakeLists) -- confirmed by hitting exactly that failure. Keep
# ON, matching kyuz0's verified-working recipe.
RUN cmake -S . -B build -G Ninja \
    -DGGML_VULKAN=ON \
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

RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install \
  bash ca-certificates libatomic libstdc++ libgcc libgomp libibverbs \
  vulkan-loader mesa-vulkan-drivers \
  && microdnf clean all && rm -rf /var/cache/dnf/*

COPY --from=builder /usr/bin/llama-server /usr/bin/llama-server
COPY --from=builder /usr/lib64/libllama.so* /usr/lib64/libllama-common.so* /usr/lib64/libllama-server-impl.so \
  /usr/lib64/libggml*.so* /usr/lib64/libmtmd*.so* /usr/lib64/
RUN ldconfig

EXPOSE 8080
ENTRYPOINT ["/usr/bin/llama-server"]
