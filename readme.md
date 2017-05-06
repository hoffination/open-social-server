# open-social-server

A large complicated server I wrote over the course of two years working on a social media startup.

I'm not looking to maintain this project going forwards.

### What I learned

This was the first major application I developed out of college. I learned a lot and wrote a lot of "bad" code that helped me learn even more. Most of what I learned can be seen in the design and architecture of this project:
- Movement toward modules to understand distinct parts of the applications
- Introduction of Data Access Objects instead of contained database calls
- Creation of services to handle similar logical blocks to reduce duplicated code
- Breaking up large sections of code into more readable chunks
- Switching from callback chains to promises

I also learned a host of other amazing things on this huge project. I've talked about a few of them over on my blog [Complete Clutter](benhofferber.com).

### Technical Details

Here are some interesting details and features of the project:
- User authentication through Facebook using Oauth
- User profiles featuring Facebook integration
- User chat system and status messages
- Push notifications to a mobile app
- Used [RethinkDB](https://rethinkdb.com/) as a database
  - I found it amazingly usable but difficult to tune for performance
- Robust error handling and reporting
- Forum service for users to share posts and comment on them
- S3 integrations to upload photos from mobile phones to be attached to user created posts
- Packaged and put into a [Elastic Beanstalk](https://aws.amazon.com/elasticbeanstalk/) scaleable service

As a closing thought, I really wished I had more testing but this project was moving too quickly to integrate testing into my workflow. Such is often the way with startups. Most of my other personal projects have incorporated testing as a result.

### Contributions
I, __Ben Hofferber__, am the sole contributor to this code base and am releasing an opensource MIT license on its use. I'm excited to see what people make of it so please fork the code.

However, I also worked closely with [Whitney Lippincott](https://github.com/WVL-IV) on the direction of this project and on the companion client.
