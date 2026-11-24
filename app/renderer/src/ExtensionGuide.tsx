import { api } from './api';

export function ExtensionGuide() {
  return (
    <section className="card">
      <h2>Tarayıcı eklentisini kur</h2>
      <p className="muted">
        Tarayıcılar açık tabların listesini dışarıdaki programlara vermez. Bu yüzden TabCatch, tab listesini bu uygulamaya
        gönderen küçük bir eklentiyle çalışır. Eklenti her tarayıcıya bir kez kurulur. Tarayıcılar mağaza dışındaki
        eklentilerin otomatik kurulmasına izin vermediği için bu adımı elle yapman gerekiyor.
      </p>
      <ol className="steps">
        <li>
          Tarayıcıda eklentiler sayfasını aç: <code>chrome://extensions</code>, <code>edge://extensions</code> veya{' '}
          <code>opera://extensions</code>
        </li>
        <li>
          <strong>Geliştirici modu</strong>nu aç.
        </li>
        <li>
          <strong>Paketlenmemiş öğe yükle</strong> (Load unpacked) butonuna bas ve aşağıdaki butonun açtığı klasörü seç.
        </li>
        <li>Bu uygulama açıkken eklenti birkaç saniye içinde otomatik bağlanır.</li>
      </ol>
      <div className="actions">
        <button className="primary" onClick={() => void api().extension.openFolder()}>
          Eklenti klasörünü aç
        </button>
      </div>
    </section>
  );
}
