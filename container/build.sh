#!/bin/bash
# Build Hydra agent container images (base + specialized variants)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="hydra-agent"

# Verify Docker is available
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    RUNTIME="docker"
else
    echo "Error: Docker is not available. Install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

echo "Using runtime: ${RUNTIME}"
echo ""

# Build base image first (other images depend on it)
echo "=========================================="
echo "Building base image: ${IMAGE_NAME}:latest"
echo "=========================================="
${RUNTIME} build -t "${IMAGE_NAME}:latest" -f Dockerfile .

# Build specialized image variants
# Each Dockerfile.* creates a variant that extends the base image

for dockerfile in Dockerfile.*; do
    if [ -f "$dockerfile" ]; then
        # Extract variant name from filename (e.g., Dockerfile.warmaster -> warmaster)
        variant="${dockerfile#Dockerfile.}"
        echo ""
        echo "=========================================="
        echo "Building variant: ${IMAGE_NAME}:${variant}"
        echo "=========================================="
        ${RUNTIME} build -t "${IMAGE_NAME}:${variant}" -f "$dockerfile" .
    fi
done

echo ""
echo "=========================================="
echo "Build complete!"
echo "=========================================="
echo ""
echo "Available images:"
${RUNTIME} images | grep "${IMAGE_NAME}" | head -10
echo ""
echo "Test base image with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${RUNTIME} run -i ${IMAGE_NAME}:latest"
