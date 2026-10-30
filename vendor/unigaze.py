"""UniGaze-B (ViT-B/16) 추론용 최소 구현.

공식 코드(https://github.com/ut-vision/UniGaze, unigaze_easy/src/unigaze/models)는
timm 0.3.2에 의존하는데, 이 버전은 지금 torch와 맞지 않는다. 그래서 같은 계산을
torch만으로 다시 적었다. 가중치 이름(vit.blocks.0.attn.qkv.weight 등)은 공식 것과 같아서
공식 safetensors 파일을 그대로 불러온다. 학습용 기능(dropout, MAE 마스킹)은 뺐다.
"""
import torch
from torch import nn

DIM = 768        # 토큰 하나의 길이
DEPTH = 12       # 트랜스포머 블록 수
HEADS = 12       # 어텐션 머리 수
PATCH = 16       # 224×224 얼굴을 16×16 조각 196개로 나눈다


class Attention(nn.Module):
    def __init__(self):
        super().__init__()
        self.qkv = nn.Linear(DIM, DIM * 3)
        self.proj = nn.Linear(DIM, DIM)

    def forward(self, x):
        batch, tokens, _ = x.shape
        # 한 번의 곱으로 q, k, v를 만들고 머리별로 나눈다
        q, k, v = self.qkv(x).reshape(batch, tokens, 3, HEADS, DIM // HEADS).permute(2, 0, 3, 1, 4)
        weights = (q @ k.transpose(-2, -1) * (DIM // HEADS) ** -0.5).softmax(dim=-1)
        x = (weights @ v).transpose(1, 2).reshape(batch, tokens, DIM)
        return self.proj(x)


class Mlp(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(DIM, DIM * 4)
        self.act = nn.GELU()
        self.fc2 = nn.Linear(DIM * 4, DIM)

    def forward(self, x):
        return self.fc2(self.act(self.fc1(x)))


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm1 = nn.LayerNorm(DIM, eps=1e-6)
        self.attn = Attention()
        self.norm2 = nn.LayerNorm(DIM, eps=1e-6)
        self.mlp = Mlp()

    def forward(self, x):
        x = x + self.attn(self.norm1(x))
        return x + self.mlp(self.norm2(x))


class PatchEmbed(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = nn.Conv2d(3, DIM, kernel_size=PATCH, stride=PATCH)

    def forward(self, x):
        # (B, 768, 14, 14) → (B, 196, 768): 조각 하나가 토큰 하나
        return self.proj(x).flatten(2).transpose(1, 2)


class ViT(nn.Module):
    def __init__(self):
        super().__init__()
        self.patch_embed = PatchEmbed()
        self.cls_token = nn.Parameter(torch.zeros(1, 1, DIM))
        self.pos_embed = nn.Parameter(torch.zeros(1, 197, DIM))
        self.blocks = nn.ModuleList(Block() for _ in range(DEPTH))
        self.norm = nn.LayerNorm(DIM, eps=1e-6)

    def forward(self, x):
        x = self.patch_embed(x)
        x = torch.cat([self.cls_token.expand(x.shape[0], -1, -1), x], dim=1) + self.pos_embed
        for block in self.blocks:
            x = block(x)
        # 공식 설정(global_pool=False): 맨 앞 cls 토큰 하나가 얼굴 전체를 요약한다
        return self.norm(x)[:, 0]


class UniGaze(nn.Module):
    def __init__(self):
        super().__init__()
        self.vit = ViT()
        self.gaze_fc = nn.Linear(DIM, 2)

    def forward(self, face):
        """face: (B, 3, 224, 224) RGB, ImageNet 평균·표준편차로 정규화. 반환: (B, 2) [pitch, yaw] 라디안."""
        return self.gaze_fc(self.vit(face))


def load(path):
    from safetensors.torch import load_file
    state = load_file(str(path))
    # vit.head는 MAE 사전학습 때 쓰던 1000개 분류 층이라 시선 추정에는 쓰지 않는다
    state = {k: v for k, v in state.items() if not k.startswith("vit.head.")}
    model = UniGaze()
    model.load_state_dict(state, strict=True)
    return model.eval()
