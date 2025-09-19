import _ from 'lodash';

const SpecialPromo = () => {
  return (
    <div className="bg-red-500 text-white p-4 m-4 rounded ring-offset-ring-4 flex justify-between">
      <div>
        <h2 className="text-xl">Up to 50% off!</h2>
        <p data-testid="lodash-version-display">Shared lodash v{_.VERSION}</p>
        <p>Only for a limited time.</p>
      </div>
      <img src="https://picsum.photos/200/200" alt="Random" className="mt-2" />
    </div>
  );
};

export default SpecialPromo;
