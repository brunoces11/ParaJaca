# ParaJaca — Blueprint do projeto

Versão 1.0 — 2026-11-17

Este é o documento-fonte do projeto: o que será construído, como e com quais regras e contratos. O documento de fases e atividades será derivado deste e criado depois.

Convenções:
- Todas as regras são obrigatórias, exceto as marcadas como "opcional" ou "condicionada".
- "(calibrar)" indica um valor inicial, que será ajustado com medições.
- Metas de desempenho são hipóteses até serem medidas.
- Em caso de dúvida, vale a solução mínima que preserve o essencial.

---

## 1. Produto

- O ParaJaca é um estúdio + player para criar e apresentar cenas imersivas 2.5D em primeira pessoa.
- Efeito central: parallax entre camadas + foco dinâmico contínuo (rack focus).
- Componentes, sobre o mesmo motor:
  - Player: apresenta uma cena publicada em sites, apresentações e telas cheias. Não tem interface de edição.
  - Estúdio: importa imagens, organiza camadas e variantes, ajusta foco, movimento, enquadramento e qualidade, salva, exporta e publica.
- Conteúdo da v1:
  - 4 a 11 camadas estáticas por variante;
  - PNG e WebP com transparência, SVG rasterizado e JPEG (só para fundo opaco).
- Funcionalidades do produto:
  - parallax e foco dinâmico;
  - camadas nítidas, com blur fixo ou com blur dinâmico;
  - enquadramento por ponto de interesse; âncora do parallax; eixo vertical; respiração de foco; deriva opcional;
  - variantes por cena; persistência local; exportação em ZIP; poster; API do player; recuperação de contexto; qualidade adaptativa.
- Critérios centrais de qualidade: imersão, regularidade dos quadros e qualidade dos assets.
- Não é: plataforma genérica, motor de jogos nem cena 3D completa.

## 2. Princípios de construção

1. Mínimo funcional primeiro. Cada incremento roda, é medido com a mesma cena de referência e decide o próximo passo.
2. Um único motor durante toda a evolução. Sem pipelines paralelos e sem código duplicado por plataforma.
3. Sem abstração antecipada: módulos, opções e generalizações entram junto com a funcionalidade que os usa.
4. Medir antes de otimizar. Otimizações e extensões só entram quando atendem ao critério de entrada (seção 25).
5. Nascem coerentes desde o início, para evitar retrabalho: separação entre player e estúdio, unidades, identidade dos assets, contrato da cena e tratamento de alfa.

## 3. Decisões fechadas

- D1. Renderização em WebGL2 (GLSL ES 3.0) num único canvas controlado pelo motor.
- D2. Blur dinâmico por pirâmide de níveis preparada na GPU ao carregar, com amostragem trilinear e LOD explícito por camada.
- D3. Cor na v1: sRGB direto em texturas RGBA8 com alfa pré-multiplicado. O desfoque em luz linear é avaliado depois, por evidência (seção 12).
- D4. Escala de textura (memória) e escala de render (carga da GPU) são independentes.
- D5. Desktop primeiro. Celular depois, como perfil de plataforma do mesmo motor.
- D6. Máquinas leves são atendidas por variantes preparadas pelo autor. Não há fusão automática de camadas.
- D7. Player e estúdio separados. O estúdio usa o player e nunca acessa o WebGL diretamente.
- D8. Modelo óptico artístico, com profundidade e foco de 0 a 100. Não é simulação física.
- D9. Qualidade manual primeiro; governador automático simples depois de medir.

## 4. Stack

- Linguagem: JavaScript com ES modules, tipado com JSDoc. A checagem de tipos (checkJs + noEmit, via TypeScript só como ferramenta) precisa passar sem erros.
- Renderização: WebGL2 e GLSL ES 3.0, sem bibliotecas.
- Núcleo e player: zero dependências de execução.
- Estúdio: HTML, CSS e JavaScript, com componentes pequenos e sem framework. ZIP com biblioteca pequena (fflate), carregada só no estúdio.
- Ferramentas: Node.js (checagem de tipos e testes); node:test para testes unitários; Playwright opcional, se trouxer benefício concreto.
- Desenvolvimento: servidor HTTP estático local (ES modules não rodam via file://). O Vite pode servir no desenvolvimento e empacota o player distribuível.
- Distribuição: hospedagem estática (ex.: GitHub Pages).
- Fora da v1: React, Preact, GSAP, WebAssembly, WebGPU, Three.js.

## 5. Arquitetura

### 5.1 Módulos

- scene: modelo, validação e IDs do formato persistido. Puro.
- optics: σ, LOD, distribuição automática de profundidade, respiração. Puro.
- motion: parallax, suavização, deriva, convergência. Puro.
- sources: busca, decodificação, rasterização de SVG, recorte, detecção de opacidade e máscara alfa.
- render: o único módulo que acessa o WebGL. Cuida de contexto, shaders, texturas, pirâmide, composição e descarte.
- quality: requisitos por camada, estimativa de memória, presets e governador.
- player: API pública; une os módulos acima; loop e entrada.
- studio: interface de edição, IndexedDB, importação, exportação ZIP, poster e diagnóstico.

### 5.2 Direção das dependências

- scene, optics e motion não importam nada do projeto.
- sources e render não conhecem player nem studio.
- player importa o núcleo. studio importa o player. Nunca o contrário.

### 5.3 Estrutura

    parajaca/
      src/core/scene/        model.js, validate.js
      src/core/              optics.js, motion.js
      src/core/sources/      image-source.js, svg-source.js, mask.js
      src/core/render/       renderer.js, pyramid.js, shaders.js, resources.js
      src/core/quality/      requirements.js, budget.js, presets.js, governor.js
      src/core/player.js
      src/studio/            app.js, panels/, storage.js, zip.js, poster.js, diagnostics.js, strings.js
      demo/                  cena de referência (PNGs do usuário) + manifesto
      tests/                 testes unitários (node:test)

Arquivos só são criados quando a funcionalidade correspondente for implementada.

## 6. Regras de código

- Código, identificadores e comentários em inglês. Textos de interface em pt-BR, centralizados em strings.js.
- Funções públicas com tipos JSDoc. A checagem de tipos faz parte da validação.
- optics, motion, scene e quality/requirements são funções puras, cobertas por testes unitários.
- Configuração persistente fica separada do estado de execução (texturas, posição suavizada, medições, qualidade automática). O estado de execução nunca é gravado no documento.
- Sem comparação profunda do modelo a cada quadro. Mudanças chegam por comandos que marcam o que precisa ser atualizado.
- Todo recurso de GPU tem dono e descarte explícito.
- Todo carregamento assíncrono aceita AbortSignal e carrega um token de geração: um resultado antigo nunca substitui uma escolha mais recente.
- Caminho quente (o loop de quadros):
  - sem alocações (reutilizar arrays tipados);
  - sem gl.getError, readPixels ou outras leituras síncronas da GPU (só no modo diagnóstico).
- Shaders compilados uma vez. Falha de compilação gera erro claro com o log do driver.
- Erros nunca são engolidos. O player emite um evento error com código (seção 7.3) e não derruba a página.
- SVG é sempre carregado como imagem (<img>), nunca injetado no DOM.
- formatVersion existe desde o primeiro arquivo; migrações só quando houver uma segunda versão.

## 7. Contratos

### 7.1 Formato da cena (scene.json, formatVersion 1)

    Scene {
      formatVersion: 1,
      id: string,                         // crypto.randomUUID
      name: string,
      reference: { width, height },       // tamanho da composição em px de autoria
      pointOfInterest: { x, y },          // 0–1 na composição; padrão 0.5, 0.5
      posterAssetId: string | null,
      defaultVariantId: string,
      assets: Asset[],
      variants: Variant[]
    }
    Asset {
      id, name,
      type: 'png' | 'webp' | 'svg' | 'jpg',
      width, height,                      // dimensões originais
      path: string                        // relativo ao manifesto (ex.: assets/<id>.png)
    }
    Variant {
      id, name,
      layers: Layer[],                    // 4 a 11
      optics: { focus, aperture, tolerance, maxBlur, focusRange: [min, max], focusSpeed, breathing },
      motion: { intensity, smoothing, axisY: boolean, anchor: 'infinity' | 'focus', drift: boolean },
      quality: { preset: 'auto' | 'high' | 'mid' | 'low', fpsTarget: 60 | 30 | 'free' }
    }
    Layer {
      id, assetId,
      placement: { x, y, width, height }, // px da composição; padrão = composição inteira
      depth: number | null,               // 0–100; null = distribuição automática
      focusMode: 'dynamic' | 'fixed' | 'sharp',
      fixedBlur: number,                  // σRef, usado em 'fixed'
      order: number                       // desempate estável na mesma profundidade
    }

Regras do formato:
- IDs são estáveis. Variantes compartilham assets por assetId, sem duplicar arquivos.
- O sufixo do arquivo (_1, _2…) é só a convenção de importação. Não é ID nem ordem de desenho.
- Ordem de desenho: depth decrescente (fundo → frente), com desempate por order.
- Campos desconhecidos são ignorados na leitura. formatVersion maior que o suportado gera o erro unsupported-format-version.
- Faixas: focus, tolerance e depth de 0 a 100; aperture de 1.4 a 16; breathing de 0 a 0,02; maxBlur e intensity até os tetos do motor.
- Não existem nearZ, speed ou outros campos sem efeito definido.

### 7.2 API do player

    createPlayer(container: HTMLElement, options?: {
      assetResolver?: (asset) => string | Blob | Promise<string | Blob>,  // padrão: resolve asset.path relativo ao manifesto
      variantId?: string,
      quality?: 'auto' | 'high' | 'mid' | 'low',
      fpsTarget?: 60 | 30 | 'free',
      diagnostics?: (sample) => void      // uso interno do estúdio
    }) → Player

    Player {
      load(source: string | Scene) → Promise<void>  // URL do manifesto ou objeto de cena
      setVariant(id) → Promise<void>
      setFocus(d: number, opts?: { animate?: boolean })  // animate padrão: true
      setQuality(preset)
      resize()                            // automático via ResizeObserver; manual opcional
      on(event, handler) → unsubscribe
      dispose()
    }

Eventos:
- ready;
- error { code, message };
- quality-change { preset, renderScale, reason };
- focus-change { d }.

- O estúdio usa o mesmo player, passando um assetResolver que entrega os blobs do IndexedDB.
- O player publicado usa o resolver padrão (URLs).
- O Web Component <parajaca-scene> é um adaptador posterior dessa API (condicionado).

### 7.3 Códigos de erro

- webgl-unavailable;
- context-lost-unrecoverable;
- invalid-scene;
- unsupported-format-version;
- asset-load-failed (com assetId);
- texture-too-large;
- memory-budget-exceeded.

Diante de qualquer erro fatal, o player mostra o poster (se houver) e continua respondendo à API sem quebrar.

### 7.4 Contratos internos (mínimos)

- sources.load(asset, resolver, targetSize, signal) → { bitmap, contentRect, opaque, alphaMask }
  - contentRect: área recortada sem transparência, em px da composição;
  - opaque: true se todos os pixels desenhados têm alfa 255;
  - alphaMask: máscara de baixa resolução para o foco por clique.
- requirements(layer, variant, viewport, preset) → { textureSize, levels, padding, maxLod }. Função pura.
- renderer:
  - prepareLayer(layerId, source, requirements, signal) → Promise
  - releaseLayer(layerId)
  - draw(frameState)
  - setViewport(cssW, cssH, dpr, renderScale)
  - dispose()
- frameState: dados de quadro já calculados (deslocamento, escala e lod por camada; zoom global). O renderer não calcula óptica.

### 7.5 Pacote exportado (.parajaca = ZIP)

    scene.json
    assets/<assetId>.<ext>     // cada asset uma única vez
    poster.webp                // referenciado por posterAssetId

- A importação valida o manifesto, os tipos e os limites de tamanho (descompactado e por arquivo), e restaura a cena sem depender do IndexedDB de origem.
- O mesmo conteúdo descompactado numa pasta é publicável: o player carrega scene.json por URL.

## 8. Unidades

- px CSS / px da composição: enquadramento, interação e aparência desejada.
- px de render: resolução efetiva do canvas = px CSS × DPR × renderScale.
- texels: pixels armazenados nas texturas.
- Valores visuais (deslocamento, σ) são definidos numa cena de referência com 1080 de altura e convertidos pelo motor:
    fatorRef = alturaExibidaDaCenaEmPxDeRender / 1080
- Regra verificável: mudar a renderScale ou a escala de textura preserva a intensidade aparente do parallax e do blur. Só a perda de detalhe é esperada.

## 9. Óptica e movimento (modelo artístico)

- Profundidade e foco: 0 = junto à câmera, 100 = infinito. A escala é inspirada em dioptrias: as diferenças pesam mais perto.
- Distribuição automática (depth null): fundo em 90 e frente em 10, com espaçamento igual em d (calibrar). Ajuste manual por camada.
- Blur:
    excesso  = max(0, |d − dFoco| − tolerância)
    kAbertura = 0,35 × (2,8 / N)                 (calibrar)
    σRef     = min(maxBlur, excesso × kAbertura)
    σRender  = σRef × fatorRef
  A abertura (f/1.4 a f/16) é controle artístico, sem equivalência com lentes reais.
- Parallax (as camadas se movem no sentido oposto ao ponteiro):
    deslocamento = −entrada × intensidade × ((dÂncora − d) / 100) × fatorRef
  - entrada: −1 a 1 por eixo, relativa ao centro da cena; eixo Y só se axisY;
  - intensidade: px de referência para Δd = 100 com entrada máxima (padrão e teto: calibrar);
  - âncora: infinity (dÂncora = 100) ou focus (dÂncora = dFoco).
- Respiração de foco (opcional): zoom global = 1 + breathing × (1 − dFoco/100), com breathing até 0,02. Nunca escala camadas separadamente.
- Suavização independente da taxa de quadros, para entrada e foco:
    cur += (alvo − cur) × (1 − exp(−k × dt))
  O k da entrada vem de smoothing; o k do foco vem de focusSpeed. dt é limitado a 100 ms, inclusive ao voltar de uma aba oculta.
- Deriva (opcional): sem entrada por 3 s, a entrada segue uma trajetória lenta de pequena amplitude (calibrar). Desligada com movimento reduzido.
- Convergência: a animação para quando o deslocamento projetado varia menos de 0,1 px de render e σ varia menos de 0,05 px (calibrar).

## 10. Renderização

- Contexto: alpha true (medir alpha false com fundo opaco), antialias false, depth false, stencil false, premultipliedAlpha true, preserveDrawingBuffer false. powerPreference só na criação.
- Limites consultados no aparelho (MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE, dimensões máximas do canvas) e respeitados.
- Tamanho do canvas: px CSS × DPR × renderScale.
- Composição: do fundo para a frente, 1 desenho por camada (um quadrilátero compartilhado e uniforms de transformação, lod e opacidade).
- Camada opaca na área desenhada (sources.opaque) é desenhada sem blending.
- Orientação da imagem resolvida nas coordenadas UV, sem flags de upload.
- Loop sob demanda via requestAnimationFrame:
  - roda enquanto houver movimento, transição de foco, deriva ou conteúdo mudando;
  - para na convergência;
  - pausa com a aba oculta (visibilitychange) e com a cena fora da tela (IntersectionObserver).
- O preparo (upload e pirâmide) acontece ao carregar ou reconstruir, nunca a cada quadro.

## 11. Blur: pirâmide

- Textura imutável (texStorage2D) com todos os níveis necessários. Dimensões que não são potência de 2 são aceitas, sem arredondamento.
- Nível k gerado a partir do nível k−1:
  - passe horizontal: nível k−1 → textura temporária, com filtro binomial 1-4-6-4-1 (/16) e redução 2× em X;
  - passe vertical: temporária → nível k, com o mesmo filtro e redução 2× em Y;
  - nunca ler e gravar a mesma textura no mesmo passe;
  - amostragem 2:1 centrada corretamente: nenhum deslocamento de imagem entre níveis (validar com imagem de teste);
  - temporários liberados ao fim do preparo.
- Modelo inicial do σ por nível, em texels da base: σk ≈ √((4^k − 1) / 3). A resposta real (redução, reconstrução, interpolação) é calibrada com imagens de referência.
- LOD por camada, calculado na CPU (cada camada é um plano com escala uniforme):
    texelsPorPixel = texels do conteúdo / px de render exibidos
    σTex    = σRender × texelsPorPixel
    lodBlur = 0,5 × log2(3 × σTex² + 1)
    lodMin  = log2(max(1, texelsPorPixel))
    lod     = clamp(max(lodBlur, lodMin), 0, últimoNível)
  - lodMin garante o mipmap quando a textura aparece reduzida, mesmo em foco (evita serrilhado e cintilação);
  - o cálculo usa o conteúdo visível, não as dimensões com padding.
- Amostragem trilinear (textureLod).
- Critérios de aceite visual:
  - transição de foco contínua entre níveis;
  - estabilidade em deslocamentos pequenos;
  - sem halos nem bordas cortadas;
  - detalhe preservado em foco;
  - aparência igual ao mudar renderScale ou escala de textura.
- Condicionadas à reprovação ou a defeito visível (seção 25): bicúbica e blur residual em cache (plano B).

## 12. Cor e alfa

- v1:
  - assets em sRGB;
  - ImageBitmap criado com premultiplyAlpha: 'premultiply' e colorSpaceConversion: 'default' (as flags UNPACK do WebGL não valem para ImageBitmap);
  - texturas RGBA8;
  - pirâmide calculada sobre os dados pré-multiplicados;
  - blending ONE / ONE_MINUS_SRC_ALPHA direto no canvas.
- Sem buffer intermediário, sem texturas float, sem conversão de cor por quadro.
- Todo tratamento de cor fica num único lugar (criação do bitmap, passe de preparo e um trecho do shader de composição), para a troca futura ser local.
- Candidato a avaliar depois da prova visual: blur em luz linear com composição em sRGB.
  - Como funciona: ImageBitmap com premultiplyAlpha 'none' → preparo converte para linear e pré-multiplica → pirâmide em SRGB8_ALPHA8 → na composição: tira a pré-multiplicação (protegendo alfa 0), converte para sRGB e pré-multiplica de novo.
  - Sem buffer nem textura float. Adotado só se a melhora visual com as imagens reais justificar o custo medido.
  - Composição totalmente linear só se esse candidato não bastar.
- A aparência de referência é a do projeto, comparada com imagens reais; não se presume equivalência universal com ferramentas de design.
- Fora da v1: HDR, bloom, realce de altas luzes, gama ampla (P3).

## 13. Modos de camada

- dynamic: acompanha o foco com a pirâmide completa.
- fixed: σ constante (fixedBlur), também com a pirâmide e lod fixo. A versão em resolução reduzida é condicionada (seção 25).
- sharp: sem blur óptico, mas mantém mipmaps para quando aparece reduzida. Não recebe foco por clique.

## 14. Recorte, padding, margem de movimento e enquadramento

- Recorte: a transparência ao redor do conteúdo é removida no preparo (contentRect), preservando a posição original na composição.
- Padding: texels transparentes adicionados só nos lados recortados (lados internos), cobrindo o alcance do filtro: 3 × σMax da camada em texels + margem de reconstrução (calibrar; medir memória). Lados que tocam a borda da composição usam CLAMP_TO_EDGE.
- Margem de movimento: os assets têm o tamanho da composição, então o movimento usa a margem do próprio asset.
  - A área visível é a composição menos a margem necessária, calculada pelo deslocamento máximo de cada camada cujo conteúdo toca a borda (pela âncora, pelo eixo Y, pelo teto de intensidade e pela respiração).
  - Se a margem disponível não bastar, o motor aumenta o zoom de enquadramento até o limite e, depois disso, limita o deslocamento daquela camada. O estúdio avisa.
- Enquadramento: cover da área visível, centrado no ponto de interesse e limitado às bordas. Ajuda no enquadramento, mas não garante que o assunto caiba em todas as proporções.
- A margem não inventa o que está escondido atrás dos objetos: isso é responsabilidade da autoria (seção 21).

## 15. Recursos e memória

- Tamanho da textura:
  - nunca maior que o necessário para exibir em renderScale 1 na viewport atual;
  - nunca maior que o asset original;
  - limitado pelo teto do preset e pelo MAX_TEXTURE_SIZE.
- Estimativa de memória: soma o tamanho real de cada nível alocado (texturas + padding) + canvas + temporários de preparo + máscaras. A GPU integrada compartilha a RAM do sistema; a estimativa não é a VRAM livre.
- Orçamento de texturas no T480: 400 MB (calibrar). Ultrapassar é tratado como erro: a carga para, emite memory-budget-exceeded e sugere preset ou variante menor.
- Carga sequencial, camada a camada. ImageBitmap.close() logo após o upload. Paralelismo só com ganho medido.
- Fontes originais:
  - estúdio: blobs comprimidos no IndexedDB;
  - player publicado: busca de novo pelas URLs (cache HTTP), sem manter blobs na memória.
- Regra de requisitos: a cada mudança, requirements() é recalculada para cada camada afetada:
  - recursos atuais atendem → só uniforms;
  - exige mais (textura maior, mais níveis, mais padding) → preparar novos recursos e trocar;
  - exige menos → reutilizar; a memória é recuperada na próxima reconstrução;
  - asset trocado → cancelar o preparo anterior e carregar o novo;
  - camada removida → liberar os recursos.
- O que entra nos requisitos: maxBlur, aperture, tolerance, focusRange, depth, focusMode, fixedBlur, anchor, axisY, viewport, proporção, preset.
- Troca: preparar o novo antes de descartar o antigo, se o orçamento permitir. Senão, mostrar uma prévia leve (o nível mais baixo da textura atual) e depois substituir.

## 16. Qualidade

- Presets (calibrar):
  - high: renderScale 1,0; teto de textura de 2160 de altura;
  - mid: renderScale 0,85; teto de 1440;
  - low: renderScale 0,7; teto de 1080;
  - auto: escolhe no início pela viewport e pela estimativa de memória da cena, de forma conservadora.
- Degraus da renderScale: 1,0 → 0,85 → 0,7 → 0,5.
- FPS alvo: 60 (principal), 30 (econômico, quadro sim, quadro não) ou free (acompanha a tela, sem presumir 120 Hz).
- Mudanças baratas (renderScale) valem na hora. Mudanças caras (teto de textura, variante) passam por reconstrução controlada.
- Governador (depois da qualidade manual; calibrar):
  - decide só com amostra de 120 quadros ativos ou mais;
  - desce um degrau da renderScale se 25% ou mais dos quadros passarem de 1,5× o intervalo alvo;
  - espera 5 s entre decisões;
  - nunca sobe sozinho;
  - para se dois degraus não melhorarem, porque o gargalo está fora da GPU (CPU, decodificação, página);
  - usa a medição de GPU (EXT_disjoint_timer_query_webgl2) de forma assíncrona quando válida;
  - emite quality-change com o motivo.
- Máquinas leves: variantes do autor (menos camadas) + preset low.
- Perfil de plataforma (celular, futuro): o mesmo motor com presets, tetos, FPS alvo e entrada próprios.

## 17. Recuperação e fallback

- Perda de contexto:
  - interromper preparos pendentes;
  - ao restaurar, recriar shaders, buffers, texturas e estado (estúdio a partir dos blobs; player a partir das URLs);
  - após 2 falhas, tentar o preset low; persistindo, emitir context-lost-unrecoverable e mostrar o poster.
- Poster:
  - imagem estática da composição, gerada pelo estúdio na exportação;
  - na prova inicial, fornecido manualmente ou capturado do canvas;
  - aparece durante a carga e no fallback.
- Sem WebGL2: poster + evento webgl-unavailable.
- O teste com WEBGL_lose_context cobre perda de contexto; não simula falta de memória nem aba encerrada.
- O fallback estático não conta como aprovação da experiência interativa.

## 18. Interação e acessibilidade

- Desktop:
  - ponteiro → parallax;
  - slider → foco;
  - clique → foco na camada mais à frente cuja silhueta (máscara alfa, com a transformação completa da camada) contém o ponto; tolerância de 6 px CSS para mouse (calibrar);
  - roda do mouse + Alt → foco; o listener só cancela o evento quando trata o foco.
- Camadas sharp não recebem foco por clique.
- Teclado: todos os controles do estúdio e do player (setas para foco quando a cena tem foco de teclado).
- prefers-reduced-motion: parallax reduzido a 20%, sem deriva, transições de foco curtas.
- Autofoco seguindo o cursor: condicionado a teste de experiência.
- Celular (perfil futuro): toque para foco e rolagem da página preservada (touch-action: pan-y); arrasto e giroscópio definidos no perfil.

## 19. Estúdio

- Cenas e variantes: criar, duplicar, renomear, excluir.
- Importação:
  - vários arquivos de uma vez; regex /_(\d{1,2})\.(png|webp|svg|jpe?g)$/i;
  - _1 = fundo, números crescentes até a frente; opção de inverter;
  - validação: sufixo duplicado ou faltando, mais de 11 ou menos de 4 camadas, tipo MIME, dimensões decodificadas, proporção diferente da composição, limite de textura do aparelho, falha de rasterização;
  - SVG: rasterizado no tamanho-alvo; avisar que recursos externos e fontes web não carregam (pedir texto convertido em curvas e recursos embutidos).
- Edição: substituir camada, reordenar, profundidade, modo de foco, óptica, movimento, enquadramento (ponto de interesse) e qualidade.
- Controles principais: foco, abertura, intensidade e qualidade. Avançados: tolerância, faixa de foco, blur máximo, respiração, deriva, escalas.
- Modo revelação: parallax no deslocamento máximo, alternando direções, com as camadas da frente em contorno.
- Diagnóstico: FPS, p95/p99 do tempo de quadro, memória estimada, overdraw estimado, renderScale atual. Mapas de profundidade e de blur são opcionais.
- Persistência:
  - IndexedDB com dois stores: projects (documentos) e blobs (assetId → Blob);
  - navigator.storage.persist() e aviso de cota;
  - aviso de que o navegador pode apagar os dados: a exportação é a garantia.
- Exportação e importação .parajaca (seção 7.5), com geração do poster.
- Histórico de edição (desfazer): condicionado.

## 20. Distribuição

- Player empacotado separado do estúdio (Vite, modo biblioteca), sem código do estúdio.
- Publicação: pasta estática com scene.json, assets/ e poster, carregada por URL.
- Uso local sempre por servidor HTTP.

## 21. Autoria dos assets (regras para o autor)

- Todas as camadas com o mesmo tamanho de composição (ex.: 2560×1440 ou 3840×2160), cada objeto na posição final.
- Nomes por sufixo: _1 = fundo, crescendo até a frente.
- Fundo opaco; demais camadas com transparência; exportação em sRGB.
- Pintura por baixo: a camada de trás tem conteúdo atrás dos objetos da frente, cobrindo o deslocamento relativo e a região do blur. O objeto da frente não aparece repetido atrás.
- Margem de cerca de 10% nas bordas sem conteúdo essencial.
- Uma camada tem uma única profundidade: chão, paredes e objetos longos devem ser divididos em camadas.
- Revisar o enquadramento em paisagem e retrato.
- Cena de referência: 7 camadas PNG fornecidas pelo usuário, com assunto claro, profundidades distinguíveis e movimento moderado. A prova inicial usa 4 delas (o fundo + 3).

## 22. Hardware, navegadores e metas

- Referência e mínimo de desktop: ThinkPad T480 (Intel 8ª geração, GPU integrada Intel UHD 620, 16 GB).
  - Registrar CPU, GPU, tela, resolução, escala do Windows e canal da memória (CPU-Z, aba Memory, "Channels").
- Navegadores: Chrome e Edge atuais (principais); Firefox atual (verificação).
- Celular (perfil futuro): classes Galaxy A5x e A1x e iPhone base de 2 a 3 gerações atrás, com os modelos confirmados quando o perfil começar.
- Metas no T480 (hipóteses):
  - 7 camadas a 60 fps em 1920×1080 internos;
  - 11 camadas com alvo de 60 fps; se necessário, preset mid (0,85) ou 30 fps;
  - variante econômica (4 camadas, preset low) a 60 fps;
  - poster em menos de 1 s; cena de 7 camadas pronta em menos de 2 s em servidor local (rede medida separada de decodificação e preparo).
- Cada medição registra: máquina, navegador, resolução, escala, assets, variante e configuração.

## 23. Validação

- Unitários (node:test): óptica, movimento, unidades, LOD, distribuição de profundidade, requisitos, estimativa de memória, validação do formato.
- Checagem de tipos sem erros.
- Visuais no T480, com a cena de referência:
  - parallax, rack focus e os dois juntos;
  - bordas, halos, cores, blocos, cintilação, estabilidade entre níveis;
  - troca de renderScale e de escala de textura preservando a aparência;
  - mudanças de tolerância, faixa de foco, profundidade, âncora, proporção e tamanho da janela.
- Desempenho:
  - tempo de preparo por etapa e até a primeira interação;
  - p95/p99 e pausas perceptíveis;
  - uso prolongado (aquecimento após alguns minutos).
- Robustez:
  - trocas repetidas de assets, variantes e tamanho da janela sem crescimento de memória;
  - perda e restauração de contexto;
  - fallback;
  - exportação, importação e equivalência da cena restaurada.
- Entrada: mouse, teclado e movimento reduzido.
- Método: cenários reproduzíveis, uma variável por vez, sempre a mesma cena.

## 24. Estratégia incremental (marcos e portões)

O detalhamento das atividades fica no documento de fases.

- A — Prova mínima:
  - entrega: renderer, pirâmide com LOD, alfa pré-multiplicado, parallax, foco por slider, 4 camadas reais, renderScale manual e medições simples;
  - portão: efeito aprovado visualmente e estável; em seguida, 7 camadas calibradas no T480.
- A2 — Qualidade visual:
  - entrega: calibração de LOD, padding, interpolação e enquadramento; comparação sRGB × candidato linear;
  - portão: aparência e custo caracterizados com 7 camadas e o caminho de 11 testado.
- B — Player completo:
  - entrega: formato e manifesto, variantes, modos de camada, recorte e margem, requisitos e memória, presets e governador, clique por silhueta, acessibilidade, API, recuperação e fallback;
  - portão: o player funciona por URL, os recursos ficam estáveis e a variante econômica atinge a meta no T480.
- C — Estúdio:
  - entrega: importação, edição, revelação, diagnóstico, IndexedDB, exportação e importação .parajaca, poster;
  - portão: criar, salvar, restaurar e publicar uma cena sem depender do estúdio de origem.
- D — Evolução:
  - entrega: perfil de celular e extensões, conforme a seção 25;
  - portão: resolver limitações observadas.

## 25. Extensões condicionadas (critério de entrada)

- Blur residual em cache: a pirâmide reprovar visualmente (é uma aproximação; medir custo e qualidade).
- Bicúbica: corrigir um defeito perceptível com custo aceitável.
- Camada fixed em resolução reduzida: economia de memória comprovada, sem perda visual.
- Malha justa: overdraw relevante no recorte retangular, sem cortar o blur.
- Impostor do fundo: reuso do cache maior que o custo de preparo.
- Fusão de camadas: só como ferramenta de autoria com prévia, sem promessa de "sem perda".
- Three.js: após prova de contexto, cor, recursos, profundidade e custo (uma cena como textura plana tem uma única profundidade).
- HTML dentro da cena: compatibilidade comprovada nos navegadores-alvo. Os controles permanecem em HTML convencional.
- Gradiente ou mapa de profundidade por camada: tratar deformação, contornos e áreas reveladas.
- KTX2/Basis: pipeline que preserve o ganho de memória e os níveis de blur.
- Web Component, histórico de edição, autofoco, bokeh de disco, giroscópio, áudio, partículas: núcleo estável e benefício demonstrado.
- Nenhuma extensão duplica o motor. Uma extensão pode ficar fora do produto se não compensar.

## 26. Fora de escopo

- Plataforma genérica, motor de jogos, editor 3D.
- Backend, contas de usuário, colaboração online.
- Pesquisa de nome e licença (decisão do usuário).

## 27. Riscos, confiança e pendências

- Confiança na direção técnica: 85/100, como julgamento preliminar, sem medições.
- Riscos principais: aparência do blur da pirâmide; memória real com assets e padding (GPU com memória compartilhada); desempenho sustentado da UHD 620; qualidade de autoria dos assets.
- Pendências:
  1. Registrar a configuração exata do T480 (seção 22).
  2. Receber as 7 camadas PNG seguindo a seção 21.
  3. Definir modelos e entrada do perfil de celular quando ele começar.

## Anexo — Decisões preservadas

- O ParaJaca é independente do JOBOM; a conversa de origem aconteceu por engano naquele repositório.
- Conceito inicial: DOM/CSS com filter: blur, translate3d, preserve-3d e GSAP. Substituído por WebGL2 porque blur animado em CSS re-rasteriza, will-change em tudo pesa e filter achata o 3D.
- A alegação "não existe produto semelhante" está fora da justificativa até haver pesquisa.
- Nome: ParaJaca (Para[llax] + Jaca).
- Não usar:
  - crossfade de opacidade em DOM;
  - Worker com ctx.filter;
  - fusão automática;
  - arredondamento para potência de 2;
  - nearZ;
  - escala por camada fora de foco;
  - micro-benchmark offscreen obrigatório;
  - governador complexo antes de medir;
  - JSON base64 como formato final;
  - classificar aparelho por categoria;
  - "um compositor para a página";
  - sharp sem mipmaps.
- Decididas por etapas: cor sRGB primeiro e candidato linear por evidência; construção mínima antes de abstrações; qualidade manual antes do governador.
