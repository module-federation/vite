const SignUpBanner = () => {
  return (
    <div className="bg-blue-500 text-white p-4 m-4 rounded ring-offset-ring-4 flex justify-between">
      <div>
        <h2 className="text-xl">Sign up now!</h2>
        <p>Get started with our amazing service today.</p>
        <button className="bg-white text-blue-500 p-2 rounded mt-2">Sign up</button>
      </div>
      <img src="https://picsum.photos/200/200" alt="Random" className="mt-2" />
    </div>
  );
};

export default SignUpBanner;
