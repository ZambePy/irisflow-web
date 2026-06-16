# IrisFlow 👁️ lasers

Um projeto de experimento utilizando MediaPipe FaceMesh para rastreamento de íris. Ao mover os olhos, um "laser" acompanha o movimento da sua pupila pela tela, ignorando os movimentos gerais da cabeça.

## Como rodar o projeto localmente

Siga os passos abaixo para testar em sua máquina:

1. **Instale as dependências:**
   No terminal, dentro da pasta do projeto, rode:
   ```bash
   npm i
   ```

2. **Inicie o servidor de desenvolvimento:**
   Em seguida, inicie o Vite rodando:
   ```bash
   npm run dev
   ```

3. **Acesse no navegador:**
   Abra a URL que aparecer no terminal (geralmente `http://localhost:5173/`).
   **Nota:** Lembre-se de dar permissão para uso da webcam!

## Tecnologias utilizadas
- Vite (Vanilla TypeScript)
- MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)
- CSS Moderno (Efeitos de Glow / Box Shadow)
