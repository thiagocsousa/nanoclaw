/**
 * O `resolve` da promessa do `connect()`, que tem de sobreviver à reconexão.
 *
 * ⛔ O bug, achado em 09/11/2026 no re-pareamento do número principal: o
 * `resolve` era passado como ARGUMENTO para `connectInternal(onFirstOpen)`, e
 * o caminho de reconexão (`whatsapp.ts`, dois lugares) chamava
 * `this.connectInternal()` **sem ele**. O `open` seguinte não resolvia nada, o
 * `await channel.connect()` do `index.ts` ficava pendurado para sempre, e o
 * processo ficava **conectado e mudo**: `Connected to WhatsApp` e
 * `Group metadata synced` no log, e nada de `Scheduler loop started`,
 * `IPC watcher started` ou `NanoClaw running`.
 *
 * O pareamento FECHA e reconecta, então era garantido no primeiro boot depois
 * de parear — mas não é só do pareamento: **qualquer** queda antes do primeiro
 * `open` fazia isso. É o mesmo sintoma que em junho/2026 foi atribuído ao
 * `await` da instância secundária; este é um segundo caminho independente para
 * ele, e ficou aberto.
 *
 * O conserto não é "passar o argumento também na reconexão" — é parar de
 * passá-lo. Enquanto a continuação viaja por parâmetro, todo call site novo
 * pode esquecer, e o esquecimento é silencioso. Aqui ela mora no objeto: quem
 * reconecta não precisa saber que ela existe.
 */
export class PrimeiroOpen {
  private resolver?: () => void;

  /** Guarda a continuação a disparar quando a conexão abrir. */
  arma(resolver: () => void): void {
    this.resolver = resolver;
  }

  /**
   * Dispara UMA vez e esquece. Devolve se havia algo armado — reconexões
   * seguintes chamam isto e não devem disparar de novo (o `connect()` já
   * resolveu; resolver duas vezes é no-op em Promise, mas a intenção é
   * explícita para quem vier depois).
   */
  dispara(): boolean {
    const r = this.resolver;
    if (!r) return false;
    this.resolver = undefined;
    r();
    return true;
  }

  get armado(): boolean {
    return this.resolver !== undefined;
  }
}
